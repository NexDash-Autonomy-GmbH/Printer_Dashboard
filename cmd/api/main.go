package main

import (
	"crypto/hmac"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"printer-dashboard/internal/bridge"
	"printer-dashboard/internal/config"
	"printer-dashboard/internal/escl"
	"printer-dashboard/internal/mail"
)

type server struct {
	cfg         config.Config
	hub         *bridge.Hub
	statMu      sync.Mutex
	statAt      time.Time
	statHost    string
	statScanner string
	statAdf     string
}

func main() {
	cfg := config.Load()
	if err := os.MkdirAll(cfg.ScanDir, 0o755); err != nil {
		log.Fatal(err)
	}
	s := &server{cfg: cfg, hub: bridge.New()}
	log.Printf("api %s  printer %s  sender %s", cfg.Listen, cfg.PrinterHost, cfg.SMTP.FromEmail)
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           s.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       75 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/state", s.handleState)
	mux.HandleFunc("/api/emails", s.handleEmails)
	mux.HandleFunc("/api/scan", s.handleScan)
	mux.HandleFunc("/bridge/poll", s.handlePoll)
	mux.HandleFunc("/bridge/result", s.handleResult)
	mux.Handle("/", spa("."))
	return withCORS(mux)
}

func (s *server) scannerStatus() (scanner, adf string) {
	s.cfg = config.Load()
	s.statMu.Lock()
	if s.cfg.PrinterHost == s.statHost && time.Since(s.statAt) < 1500*time.Millisecond {
		scanner, adf = s.statScanner, s.statAdf
		s.statMu.Unlock()
		return
	}
	s.statMu.Unlock()
	scanner, adf = escl.Status(s.cfg.PrinterHost)
	s.statMu.Lock()
	s.statHost = s.cfg.PrinterHost
	s.statAt = time.Now()
	s.statScanner, s.statAdf = scanner, adf
	s.statMu.Unlock()
	return
}

func (s *server) handleState(w http.ResponseWriter, r *http.Request) {
	s.cfg = config.Load()
	scanner, adf := s.scannerStatus()
	writeJSON(w, http.StatusOK, map[string]any{
		"printer_host":     s.cfg.PrinterHost,
		"model":            "Xerox B305 MFP",
		"scanner":          scanner,
		"adf":              adf,
		"scan_dir":         s.cfg.ScanDir,
		"from_email":       s.cfg.SMTP.FromEmail,
		"from_name":        s.cfg.SMTP.FromName,
		"ses_region":       s.cfg.SMTP.Host,
		"emails":           s.cfg.Emails,
		"workspace_emails": s.cfg.WorkspaceEmails,
		"web_ui":           "http://" + s.cfg.PrinterHost + "/",
		"bridge_online":    s.hub.Online(),
	})
}

func (s *server) handleEmails(w http.ResponseWriter, r *http.Request) {
	s.cfg = config.Load()
	switch r.Method {
	case http.MethodPost:
		r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
		var body struct {
			Email string `json:"email"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad json"})
			return
		}
		email := strings.ToLower(strings.TrimSpace(body.Email))
		if email == s.cfg.SMTP.FromEmail {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": email + " is the sender, not a recipient"})
			return
		}
		emails := append([]string{}, s.cfg.Emails...)
		found := false
		for _, e := range emails {
			if e == email {
				found = true
			}
		}
		if !found {
			emails = append(emails, email)
			if err := s.cfg.SaveEmails(emails); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "emails": s.cfg.Emails, "added": !found})
	case http.MethodDelete:
		email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))
		kept := []string{}
		for _, e := range s.cfg.Emails {
			if e != email {
				kept = append(kept, e)
			}
		}
		if err := s.cfg.SaveEmails(kept); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "emails": s.cfg.Emails})
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
	}
}

func (s *server) handleScan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	s.cfg = config.Load()
	r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
	var body struct {
		Source string `json:"source"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Source == "" {
		body.Source = "platen"
	}
	scanner, adf := escl.Status(s.cfg.PrinterHost)
	var pages []escl.Page
	var err error
	if scanner != "unreachable" {
		src, perr := escl.PickSource(adf, body.Source)
		if perr != nil {
			writeJSON(w, http.StatusOK, fail("scan_failed", perr.Error()))
			return
		}
		pages, err = escl.Scan(s.cfg.PrinterHost, src)
	} else if s.hub.Online() {
		job, jerr := s.hub.Submit(body.Source)
		if jerr != nil {
			writeJSON(w, http.StatusOK, fail("scan_failed", jerr.Error()))
			return
		}
		select {
		case res := <-job.Done:
			if res.Err != nil {
				writeJSON(w, http.StatusOK, fail("scan_failed", res.Err.Error()))
				return
			}
			for _, p := range res.Pages {
				pages = append(pages, escl.Page{Type: "application/pdf", Data: p})
			}
		case <-time.After(3 * time.Minute):
			s.hub.Cancel(job.ID, errString("office bridge did not return a scan"))
			writeJSON(w, http.StatusOK, fail("scan_failed", "office bridge did not return a scan"))
			return
		}
	} else {
		writeJSON(w, http.StatusOK, fail("scan_failed", "printer unreachable and the office bridge is not connected"))
		return
	}
	if err != nil {
		writeJSON(w, http.StatusOK, fail("scan_failed", err.Error()))
		return
	}
	pdf, err := escl.WritePDF(pages)
	if err != nil {
		writeJSON(w, http.StatusOK, fail("scan_failed", err.Error()))
		return
	}
	name := "scan_" + time.Now().Format("2006-01-02_15-04-05") + ".pdf"
	if err := os.MkdirAll(s.cfg.ScanDir, 0o755); err != nil {
		writeJSON(w, http.StatusOK, fail("scan_failed", err.Error()))
		return
	}
	path := filepath.Join(s.cfg.ScanDir, name)
	if err := os.WriteFile(path, pdf, 0o644); err != nil {
		writeJSON(w, http.StatusOK, fail("scan_failed", err.Error()))
		return
	}
	if len(s.cfg.Emails) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "stage": "saved", "scanned": true, "emailed": false,
			"files": []string{path}, "log": []string{"saved " + path},
		})
		return
	}
	err = mail.Send(s.cfg.SMTP, s.cfg.Emails, "Xerox scan "+name, "Scan from the Xerox B305.\n", pdf, name)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "stage": "mail_failed", "scanned": true, "emailed": false,
			"error": err.Error(), "files": []string{path},
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "stage": "sent", "scanned": true, "emailed": true,
		"files": []string{path}, "recipients": s.cfg.Emails,
	})
}

func (s *server) authorized(r *http.Request) bool {
	header := r.Header.Get("Authorization")
	got := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if s.cfg.BridgeToken == "" || got == "" || !strings.HasPrefix(header, "Bearer ") {
		return false
	}
	return hmac.Equal([]byte(got), []byte(s.cfg.BridgeToken))
}

func (s *server) handlePoll(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	job := s.hub.Wait(20 * time.Second)
	if job == nil {
		writeJSON(w, http.StatusOK, map[string]any{"job": ""})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job":     job.ID,
		"source":  job.Source,
		"printer": s.cfg.PrinterHost,
	})
}

func (s *server) handleResult(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	id := r.URL.Query().Get("job")
	errMsg := r.URL.Query().Get("error")
	r.Body = http.MaxBytesReader(w, r.Body, 20<<20)
	data, _ := io.ReadAll(r.Body)
	res := bridge.Result{}
	if errMsg != "" {
		res.Err = errString(errMsg)
	} else {
		res.Pages = [][]byte{data}
	}
	s.hub.Finish(id, res)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type errString string

func (e errString) Error() string { return string(e) }

func fail(stage, msg string) map[string]any {
	return map[string]any{"ok": false, "stage": stage, "scanned": false, "emailed": false, "error": msg}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func withCORS(next http.Handler) http.Handler {
	allowed := corsList()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if originAllowed(origin, allowed) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func corsList() []string {
	out := []string{"https://printer-dashboard.pages.dev"}
	for _, part := range strings.Split(os.Getenv("CORS_ORIGINS"), ",") {
		p := strings.TrimSpace(strings.TrimRight(part, "/"))
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func originAllowed(origin string, allowed []string) bool {
	if origin == "" {
		return false
	}
	if strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:") {
		return true
	}
	for _, a := range allowed {
		if origin == a {
			return true
		}
	}
	return false
}

func spa(root string) http.Handler {
	dist := filepath.Join(root, "dist")
	fs := http.FileServer(http.Dir(dist))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/bridge/") {
			http.NotFound(w, r)
			return
		}
		path := filepath.Join(dist, filepath.Clean(r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fs.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(dist, "index.html"))
	})
}
