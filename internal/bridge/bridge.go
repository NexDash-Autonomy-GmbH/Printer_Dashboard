package bridge

import (
	"sync"
	"time"
)

type Job struct {
	ID     string
	Source string
	Done   chan Result
}

type Result struct {
	Pages [][]byte
	Err   error
}

type Hub struct {
	mu       sync.Mutex
	cond     *sync.Cond
	queued   *Job
	active   *Job
	lastSeen time.Time
}

func New() *Hub {
	h := &Hub{}
	h.cond = sync.NewCond(&h.mu)
	return h
}

func (h *Hub) Online() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return !h.lastSeen.IsZero() && time.Since(h.lastSeen) < 45*time.Second
}

func (h *Hub) Touch() {
	h.mu.Lock()
	h.lastSeen = time.Now()
	h.mu.Unlock()
}

func (h *Hub) Submit(source string) (*Job, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.queued != nil || h.active != nil {
		return nil, errBusy
	}
	job := &Job{ID: time.Now().Format("150405.000"), Source: source, Done: make(chan Result, 1)}
	h.queued = job
	h.cond.Broadcast()
	return job, nil
}

func (h *Hub) Take() *Job {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastSeen = time.Now()
	return h.claimLocked()
}

func (h *Hub) Wait(d time.Duration) *Job {
	timer := time.AfterFunc(d, func() {
		h.mu.Lock()
		h.cond.Broadcast()
		h.mu.Unlock()
	})
	defer timer.Stop()

	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastSeen = time.Now()
	deadline := time.Now().Add(d)
	for h.queued == nil && time.Now().Before(deadline) {
		h.cond.Wait()
	}
	h.lastSeen = time.Now()
	return h.claimLocked()
}

func (h *Hub) claimLocked() *Job {
	if h.queued == nil {
		return nil
	}
	h.active = h.queued
	h.queued = nil
	return h.active
}

func (h *Hub) Finish(id string, res Result) {
	h.mu.Lock()
	var job *Job
	switch {
	case h.active != nil && h.active.ID == id:
		job = h.active
		h.active = nil
	case h.queued != nil && h.queued.ID == id:
		job = h.queued
		h.queued = nil
	}
	h.mu.Unlock()
	if job == nil {
		return
	}
	select {
	case job.Done <- res:
	default:
	}
}

func (h *Hub) Cancel(id string, err error) {
	h.Finish(id, Result{Err: err})
}

var errBusy = errString("bridge is busy")

type errString string

func (e errString) Error() string { return string(e) }
