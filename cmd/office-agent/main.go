package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"time"

	"printer-dashboard/internal/config"
	"printer-dashboard/internal/escl"
)

// Run this on a machine that can reach the Xerox (office LAN).
// It is the Go stand-in for the ESP8266: poll the API, scan, POST the PDF back.

var httpc = &http.Client{
	Transport: &http.Transport{
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
	},
}

func main() {
	cfg := config.Load()
	api := env("API_BASE", "http://127.0.0.1:8780")
	token := cfg.BridgeToken
	log.Printf("office-agent api=%s printer=%s", api, cfg.PrinterHost)
	for {
		job, source, printer, err := poll(api, token)
		if err != nil {
			log.Println("poll", err)
			time.Sleep(3 * time.Second)
			continue
		}
		if job == "" {
			continue
		}
		if printer == "" {
			printer = cfg.PrinterHost
		}
		_, adf := escl.Status(printer)
		src, err := escl.PickSource(adf, source)
		if err != nil {
			post(api, token, job, err.Error(), nil)
			continue
		}
		pages, err := escl.Scan(printer, src)
		if err != nil {
			post(api, token, job, err.Error(), nil)
			continue
		}
		pdf, err := escl.WritePDF(pages)
		if err != nil {
			post(api, token, job, err.Error(), nil)
			continue
		}
		post(api, token, job, "", pdf)
	}
}

func poll(api, token string) (job, source, printer string, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, api+"/bridge/poll", nil)
	if err != nil {
		return "", "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := httpc.Do(req)
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", "", "", fmt.Errorf("poll HTTP %d", resp.StatusCode)
	}
	var out struct {
		Job     string `json:"job"`
		Source  string `json:"source"`
		Printer string `json:"printer"`
	}
	err = json.NewDecoder(resp.Body).Decode(&out)
	return out.Job, out.Source, out.Printer, err
}

func post(api, token, job, errMsg string, pdf []byte) {
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	q := url.Values{}
	q.Set("job", job)
	if errMsg != "" {
		q.Set("error", errMsg)
	}
	u := api + "/bridge/result?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(pdf))
	if err != nil {
		log.Println("result", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/pdf")
	resp, err := httpc.Do(req)
	if err != nil {
		log.Println("result", err)
		return
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
