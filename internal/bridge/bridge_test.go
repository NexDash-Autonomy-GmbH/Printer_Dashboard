package bridge

import (
	"testing"
	"time"
)

func TestOnlineAfterTouch(t *testing.T) {
	h := New()
	if h.Online() {
		t.Fatal("expected offline")
	}
	h.Touch()
	if !h.Online() {
		t.Fatal("expected online after touch")
	}
}

func TestSubmitTakeFinish(t *testing.T) {
	h := New()
	job, err := h.Submit("platen")
	if err != nil {
		t.Fatal(err)
	}
	got := h.Take()
	if got == nil || got.ID != job.ID {
		t.Fatalf("take = %#v", got)
	}
	go func() { h.Finish(job.ID, Result{Pages: [][]byte{[]byte("%PDF")}}) }()
	select {
	case res := <-job.Done:
		if res.Err != nil || string(res.Pages[0]) != "%PDF" {
			t.Fatalf("result %#v", res)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}

func TestSubmitBusy(t *testing.T) {
	h := New()
	if _, err := h.Submit("platen"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Submit("adf"); err == nil {
		t.Fatal("expected busy")
	}
}
