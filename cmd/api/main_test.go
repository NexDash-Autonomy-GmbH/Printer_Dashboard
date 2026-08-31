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

func TestHealth(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()
	res, err := http.Get(api.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
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
	if !strings.Contains(errMsg, "bridge") {
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

func TestBridgeRejectsQueryToken(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()
	res, err := http.Get(api.URL + "/bridge/poll?token=test-token")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestBridgeRejectsWrongBearer(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()
	req, _ := http.NewRequest(http.MethodGet, api.URL+"/bridge/poll", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestCORSAllowsPagesAndBlocksOthers(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()

	req, _ := http.NewRequest(http.MethodGet, api.URL+"/api/state", nil)
	req.Header.Set("Origin", "https://printer-dashboard.pages.dev")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.Header.Get("Access-Control-Allow-Origin") != "https://printer-dashboard.pages.dev" {
		t.Fatalf("allow origin %q", res.Header.Get("Access-Control-Allow-Origin"))
	}

	bad, _ := http.NewRequest(http.MethodGet, api.URL+"/api/state", nil)
	bad.Header.Set("Origin", "https://evil.example")
	res, err = http.DefaultClient.Do(bad)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if got := res.Header.Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unexpected allow origin %q", got)
	}
}

func TestBridgeScanSavesPDF(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		deadline := time.Now().Add(8 * time.Second)
		for time.Now().Before(deadline) {
			req, _ := http.NewRequest(http.MethodGet, api.URL+"/bridge/poll", nil)
			req.Header.Set("Authorization", "Bearer test-token")
			resp, err := http.DefaultClient.Do(req)
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
			put, _ := http.NewRequest(http.MethodPost, api.URL+"/bridge/result?job="+poll.Job, bytes.NewReader(pdf))
			put.Header.Set("Authorization", "Bearer test-token")
			put.Header.Set("Content-Type", "application/pdf")
			r, err := http.DefaultClient.Do(put)
			if err == nil {
				r.Body.Close()
			}
			return
		}
	}()

	deadline := time.Now().Add(2 * time.Second)
	online := false
	for time.Now().Before(deadline) {
		res, err := http.Get(api.URL + "/api/state")
		if err == nil {
			var st map[string]any
			_ = json.NewDecoder(res.Body).Decode(&st)
			res.Body.Close()
			if st["bridge_online"] == true {
				online = true
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !online {
		t.Fatal("bridge never came online")
	}

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

func TestTelemetryRejectsQueryToken(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()
	req, _ := http.NewRequest(http.MethodPost, api.URL+"/bridge/telemetry?token=test-token", strings.NewReader(`{"online":true,"status":"Idle","toners":[],"trays":[]}`))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", res.StatusCode)
	}
}

func TestFakeEspTelemetryShowsInState(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()
	payload := `{"online":true,"status":"Idle","pages":1234,"toners":[{"name":"Black Toner","pct":41,"color":"#1e293b"}],"trays":[{"name":"Tray 1","pct":80,"status":"Available","level":400,"capacity":550}],"alerts":[],"checked_at":1700000000}`
	req, _ := http.NewRequest(http.MethodPost, api.URL+"/bridge/telemetry", strings.NewReader(payload))
	req.Header.Set("Authorization", "Bearer test-token")
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	st, err := http.Get(api.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(st.Body).Decode(&body)
	sup, _ := body["supplies"].(map[string]any)
	if sup == nil || sup["status"] != "Idle" || sup["pages"] != float64(1234) {
		t.Fatalf("supplies %#v", body["supplies"])
	}
	if body["bridge_online"] != true {
		t.Fatal("expected bridge online after telemetry")
	}
}

func TestFakeEspScanThenTelemetry(t *testing.T) {
	api := testServer(t, "http://127.0.0.1:1")
	defer api.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		deadline := time.Now().Add(8 * time.Second)
		postedTel := false
		for time.Now().Before(deadline) {
			if !postedTel {
				tel, _ := http.NewRequest(http.MethodPost, api.URL+"/bridge/telemetry", strings.NewReader(`{"online":true,"status":"Idle","toners":[{"name":"Black Toner","pct":50,"color":"#111"}],"trays":[],"alerts":[],"checked_at":1}`))
				tel.Header.Set("Authorization", "Bearer test-token")
				tel.Header.Set("Content-Type", "application/json")
				r, err := http.DefaultClient.Do(tel)
				if err == nil {
					r.Body.Close()
					postedTel = true
				}
			}
			req, _ := http.NewRequest(http.MethodGet, api.URL+"/bridge/poll", nil)
			req.Header.Set("Authorization", "Bearer test-token")
			resp, err := http.DefaultClient.Do(req)
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
			put, _ := http.NewRequest(http.MethodPost, api.URL+"/bridge/result?job="+poll.Job, bytes.NewReader([]byte("%PDF-1.4 esp")))
			put.Header.Set("Authorization", "Bearer test-token")
			put.Header.Set("Content-Type", "application/pdf")
			r, err := http.DefaultClient.Do(put)
			if err == nil {
				r.Body.Close()
			}
			return
		}
	}()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		res, err := http.Get(api.URL + "/api/state")
		if err == nil {
			var st map[string]any
			_ = json.NewDecoder(res.Body).Decode(&st)
			res.Body.Close()
			if st["bridge_online"] == true {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}

	res, err := http.Post(api.URL+"/api/scan", "application/json", strings.NewReader(`{"source":"platen"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	<-done
	if body["ok"] != true || body["stage"] != "saved" {
		t.Fatalf("scan %#v", body)
	}
	st, err := http.Get(api.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Body.Close()
	var state map[string]any
	_ = json.NewDecoder(st.Body).Decode(&state)
	sup, _ := state["supplies"].(map[string]any)
	if sup == nil || sup["status"] != "Idle" {
		t.Fatalf("supplies after scan %#v", state["supplies"])
	}
}
