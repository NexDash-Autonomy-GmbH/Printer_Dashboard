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

func TestTakeClaimsJob(t *testing.T) {
	h := New()
	job, err := h.Submit("platen")
	if err != nil {
		t.Fatal(err)
	}
	if got := h.Take(); got == nil || got.ID != job.ID {
		t.Fatalf("first take %#v", got)
	}
	if got := h.Take(); got != nil {
		t.Fatalf("second take should be nil, got %#v", got)
	}
	h.Finish(job.ID, Result{})
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

func TestWaitWakesOnSubmit(t *testing.T) {
	h := New()
	done := make(chan *Job, 1)
	go func() { done <- h.Wait(time.Second) }()
	time.Sleep(20 * time.Millisecond)
	job, err := h.Submit("adf")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		if got == nil || got.ID != job.ID {
			t.Fatalf("%#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("wait did not wake")
	}
}

func TestWaitEmptyTimesOut(t *testing.T) {
	h := New()
	if got := h.Wait(80 * time.Millisecond); got != nil {
		t.Fatalf("got %#v", got)
	}
}

func TestCancelUnblocksSubmit(t *testing.T) {
	h := New()
	job, err := h.Submit("platen")
	if err != nil {
		t.Fatal(err)
	}
	h.Take()
	h.Cancel(job.ID, errString("timeout"))
	if _, err := h.Submit("platen"); err != nil {
		t.Fatalf("submit after cancel: %v", err)
	}
}
