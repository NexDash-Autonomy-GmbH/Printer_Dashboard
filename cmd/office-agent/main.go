package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"printer-dashboard/internal/config"
	"printer-dashboard/internal/escl"
)

// Run this on a machine that can reach the Xerox (office LAN).
// It is the Go stand-in for the ESP32: poll the API, scan, POST the PDF back.

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
	req, err := http.NewRequest(http.MethodGet, api+"/bridge/poll", nil)
	if err != nil {
		return "", "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()
	var out struct {
		Job     string `json:"job"`
		Source  string `json:"source"`
		Printer string `json:"printer"`
	}
	err = json.NewDecoder(resp.Body).Decode(&out)
	return out.Job, out.Source, out.Printer, err
}

func post(api, token, job, errMsg string, pdf []byte) {
	u := fmt.Sprintf("%s/bridge/result?job=%s", api, job)
	if errMsg != "" {
		u += "&error=" + errMsg
	}
	req, err := http.NewRequest(http.MethodPost, u, bytes.NewReader(pdf))
	if err != nil {
		log.Println("result", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/pdf")
	resp, err := http.DefaultClient.Do(req)
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
