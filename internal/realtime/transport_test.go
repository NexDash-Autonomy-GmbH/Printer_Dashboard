package realtime

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// Long-poll: client GET, server holds until a job exists (our ESP path).
func TestLongPollDeliversJob(t *testing.T) {
	var mu sync.Mutex
	job := ""
	ready := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			mu.Lock()
			j := job
			mu.Unlock()
			if j != "" {
				fmt.Fprintf(w, `{"job":%q}`, j)
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		fmt.Fprint(w, `{"job":""}`)
	}))
	defer srv.Close()

	start := time.Now()
	go func() {
		time.Sleep(50 * time.Millisecond)
		mu.Lock()
		job = "j1"
		mu.Unlock()
		close(ready)
	}()
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	<-ready
	elapsed := time.Since(start)
	if !strings.Contains(string(body), "j1") {
		t.Fatalf("body %s", body)
	}
	if elapsed > 500*time.Millisecond {
		t.Fatalf("long-poll too slow: %s", elapsed)
	}
	t.Logf("long-poll job latency %s", elapsed)
}

// SSE: one GET, server writes text/event-stream events (browser status path).
func TestSSEPushesStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		fl, ok := w.(http.Flusher)
		if !ok {
			t.Fatal("no flush")
		}
		fmt.Fprintf(w, "event: scanning\ndata: {\"stage\":\"scanning\"}\n\n")
		fl.Flush()
		time.Sleep(30 * time.Millisecond)
		fmt.Fprintf(w, "event: sent\ndata: {\"stage\":\"sent\"}\n\n")
		fl.Flush()
	}))
	defer srv.Close()

	start := time.Now()
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content-type %s", ct)
	}
	r := bufio.NewReader(res.Body)
	events := 0
	for events < 2 {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(line, "event:") {
			events++
		}
	}
	t.Logf("sse two events in %s", time.Since(start))
}

func TestLongPollEmptyTimesOutCleanly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(80 * time.Millisecond)
		fmt.Fprint(w, `{"job":""}`)
	}))
	defer srv.Close()
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(body) != `{"job":""}` {
		t.Fatalf("%s", body)
	}
}
