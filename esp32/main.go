// TinyGo firmware for an ESP32 that sits on the office Wi-Fi.
// It long-polls the Go API, then talks eSCL to the Xerox on the LAN.
//
// Fill wifi.go (from wifi.example.go) then:
//
//	tinygo flash -target=esp32 -port /dev/cu.wchusbserial210 ./esp32
package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"time"
)

func main() {
	println("esp32 bridge api", apiBase, "ssid", wifiSSID)
	_ = wifiPass
	for {
		job, source, printer, err := poll()
		if err != nil {
			time.Sleep(3 * time.Second)
			continue
		}
		if job == "" {
			continue
		}
		pdf, err := scan(printer, source)
		if err != nil {
			_, _ = postResult(job, err.Error(), nil)
			continue
		}
		_, _ = postResult(job, "", pdf)
	}
}

func poll() (job, source, printer string, err error) {
	url := apiBase + "/bridge/poll?token=" + bridgeToken
	resp, err := http.Get(url)
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	job = jsonField(body, "job")
	source = jsonField(body, "source")
	printer = jsonField(body, "printer")
	return job, source, printer, nil
}

func scan(printerHost, source string) ([]byte, error) {
	input := "Platen"
	if source == "adf" {
		input = "Feeder"
	}
	xml := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.6</pwg:Version>
  <scan:Intent>Document</scan:Intent>
  <pwg:InputSource>%s</pwg:InputSource>
  <pwg:DocumentFormat>application/pdf</pwg:DocumentFormat>
  <scan:ColorMode>RGB24</scan:ColorMode>
  <scan:XResolution>300</scan:XResolution>
  <scan:YResolution>300</scan:YResolution>
</scan:ScanSettings>`, input)
	base := "http://" + printerHost
	resp, err := http.Post(base+"/eSCL/ScanJobs", "text/xml", bytes.NewReader([]byte(xml)))
	if err != nil {
		return nil, err
	}
	resp.Body.Close()
	if resp.StatusCode != 201 && resp.StatusCode != 200 {
		return nil, fmt.Errorf("scan rejected %d", resp.StatusCode)
	}
	loc := resp.Header.Get("Location")
	if loc == "" {
		return nil, fmt.Errorf("no job url")
	}
	if loc[0] == '/' {
		loc = base + loc
	}
	r, err := http.Get(loc + "/NextDocument")
	if err != nil {
		return nil, err
	}
	data, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != 200 || len(data) == 0 {
		return nil, fmt.Errorf("no document")
	}
	return data, nil
}

func postResult(job, errMsg string, pdf []byte) (*http.Response, error) {
	url := apiBase + "/bridge/result?token=" + bridgeToken + "&job=" + job
	if errMsg != "" {
		url += "&error=" + errMsg
	}
	return http.Post(url, "application/pdf", bytes.NewReader(pdf))
}

func jsonField(body []byte, key string) string {
	needle := []byte(`"` + key + `":"`)
	i := bytes.Index(body, needle)
	if i < 0 {
		needle = []byte(`"` + key + `": "`)
		i = bytes.Index(body, needle)
		if i < 0 {
			return ""
		}
	}
	rest := body[i+len(needle):]
	j := bytes.IndexByte(rest, '"')
	if j < 0 {
		return ""
	}
	return string(rest[:j])
}
