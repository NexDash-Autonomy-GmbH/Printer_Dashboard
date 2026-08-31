package escl

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestPickSourceEmptyFeeder(t *testing.T) {
	if _, err := PickSource("ScannerAdfEmpty", "adf"); err == nil {
		t.Fatal("expected empty feeder error")
	}
}

func TestPickSourceGlass(t *testing.T) {
	src, err := PickSource("ScannerAdfEmpty", "platen")
	if err != nil || src != "Platen" {
		t.Fatalf("got %s %v", src, err)
	}
}

func TestPickSourceAutoUsesFeederWhenLoaded(t *testing.T) {
	src, err := PickSource("ScannerAdfLoaded", "auto")
	if err != nil || src != "Feeder" {
		t.Fatalf("got %s %v", src, err)
	}
}

func TestWritePDFSingle(t *testing.T) {
	out, err := WritePDF([]Page{{Type: "application/pdf", Data: []byte("%PDF-1.4")}})
	if err != nil || string(out) != "%PDF-1.4" {
		t.Fatalf("got %q %v", out, err)
	}
}

func TestScanDeletesJob(t *testing.T) {
	var deleted atomic.Bool
	var nextHits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/eSCL/ScanJobs" && r.Method == http.MethodPost:
			io.Copy(io.Discard, r.Body)
			w.Header().Set("Location", "/eSCL/ScanJobs/abc")
			w.WriteHeader(http.StatusCreated)
		case r.URL.Path == "/eSCL/ScanJobs/abc/NextDocument" && r.Method == http.MethodGet:
			n := nextHits.Add(1)
			if n == 1 {
				w.Header().Set("Content-Type", "application/pdf")
				w.Write([]byte("%PDF-1.4"))
				return
			}
			http.NotFound(w, r)
		case r.URL.Path == "/eSCL/ScanJobs/abc" && r.Method == http.MethodDelete:
			deleted.Store(true)
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	host := strings.TrimPrefix(srv.URL, "http://")
	pages, err := Scan(host, "Platen")
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 1 || string(pages[0].Data) != "%PDF-1.4" {
		t.Fatalf("pages=%#v", pages)
	}
	if !deleted.Load() {
		t.Fatal("scanner job was not deleted")
	}
}
