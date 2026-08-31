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
	"time"

	"printer-dashboard/internal/bridge"
	"printer-dashboard/internal/config"
	"printer-dashboard/internal/escl"
	"printer-dashboard/internal/mail"
)

type server struct {
	cfg config.Config
	hub *bridge.Hub
}

func main() {
	cfg := config.Load()
	if err := os.MkdirAll(cfg.ScanDir, 0o755); err != nil {
		log.Fatal(err)
	}
	s := &server{cfg: cfg, hub: bridge.New()}
	log.Printf("api %s  printer %s  sender %s", cfg.Listen, cfg.PrinterHost, cfg.SMTP.FromEmail)
	log.Fatal(http.ListenAndServe(cfg.Listen, s.routes()))
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

func (s *server) handleState(w http.ResponseWriter, r *http.Request) {
	s.cfg = config.Load()
	scanner, adf := escl.Status(s.cfg.PrinterHost)
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
			writeJSON(w, http.StatusOK, fail("scan_failed", "ESP32 did not return a scan"))
			return
		}
	} else {
		writeJSON(w, http.StatusOK, fail("scan_failed", "printer unreachable and ESP32 is not connected"))
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
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	got = strings.TrimSpace(got)
	if got == "" {
		got = r.URL.Query().Get("token")
	}
	if s.cfg.BridgeToken == "" || got == "" {
		return false
	}
	return hmac.Equal([]byte(got), []byte(s.cfg.BridgeToken))
}

func (s *server) handlePoll(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	s.hub.Touch()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if job := s.hub.Take(); job != nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"job":     job.ID,
				"source":  job.Source,
				"printer": s.cfg.PrinterHost,
			})
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	writeJSON(w, http.StatusOK, map[string]any{"job": ""})
}

func (s *server) handleResult(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	id := r.URL.Query().Get("job")
	errMsg := r.URL.Query().Get("error")
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
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
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
