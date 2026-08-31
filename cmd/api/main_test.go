package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"printer-dashboard/internal/bridge"
	"printer-dashboard/internal/config"
)

func testServer(t *testing.T, printerURL string) *httptest.Server {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("PRINTER_HOST", strings.TrimPrefix(printerURL, "http://"))
	t.Setenv("SCAN_DIR", filepath.Join(dir, "scans"))
	t.Setenv("SMTP_USER", "parth@nexdash.com")
	t.Setenv("SMTP_FROM_EMAIL", "parth@nexdash.com")
	t.Setenv("SMTP_PASSWORD", "unused-in-these-tests")
	t.Setenv("BRIDGE_TOKEN", "test-token")
	t.Setenv("API_LISTEN", "127.0.0.1:0")
	s := &server{cfg: config.Load(), hub: bridge.New()}
	return httptest.NewServer(s.routes())
}

func TestStateUnreachablePrinter(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()
	res, err := http.Get(api.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["scanner"] != "unreachable" {
		t.Fatalf("scanner=%v", body["scanner"])
	}
	if body["from_email"] != "parth@nexdash.com" {
		t.Fatalf("from=%v", body["from_email"])
	}
}

func TestScanFailsWithoutPrinterOrBridge(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()
	res, err := http.Post(api.URL+"/api/scan", "application/json", strings.NewReader(`{"source":"platen"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	if body["ok"] != false || body["stage"] != "scan_failed" {
		t.Fatalf("%v", body)
	}
	errMsg, _ := body["error"].(string)
	if !strings.Contains(errMsg, "ESP32") {
		t.Fatalf("error=%q", errMsg)
	}
}

func TestRejectSenderAsRecipient(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()
	res, err := http.Post(api.URL+"/api/emails", "application/json", strings.NewReader(`{"email":"parth@nexdash.com"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestBridgeScanSavesPDF(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			resp, err := http.Get(api.URL + "/bridge/poll?token=test-token")
			if err != nil {
				return
			}
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			var poll struct {
				Job string `json:"job"`
			}
			_ = json.Unmarshal(raw, &poll)
			if poll.Job == "" {
				continue
			}
			pdf := []byte("%PDF-1.4 test")
			req, _ := http.NewRequest(http.MethodPost, api.URL+"/bridge/result?token=test-token&job="+poll.Job, bytes.NewReader(pdf))
			req.Header.Set("Content-Type", "application/pdf")
			r, err := http.DefaultClient.Do(req)
			if err == nil {
				r.Body.Close()
			}
			return
		}
	}()

	res, err := http.Post(api.URL+"/api/scan", "application/json", strings.NewReader(`{"source":"platen"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	<-done
	if body["ok"] != true || body["stage"] != "saved" {
		t.Fatalf("%v", body)
	}
	files, _ := body["files"].([]any)
	if len(files) != 1 {
		t.Fatalf("files %v", files)
	}
	path, _ := files[0].(string)
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, []byte("%PDF-1.4 test")) {
		t.Fatalf("pdf %q %v", got, err)
	}
}
