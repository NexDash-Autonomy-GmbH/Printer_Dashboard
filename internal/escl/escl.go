package escl

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	A4Width  = 2480
	A4Height = 3508
	MaxPages = 200
)

var client = &http.Client{
	Timeout: 180 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        8,
		MaxIdleConnsPerHost: 4,
		IdleConnTimeout:     30 * time.Second,
		DisableCompression:  false,
	},
}

func shortClient() *http.Client {
	return &http.Client{
		Timeout:   2 * time.Second,
		Transport: client.Transport,
	}
}

type Page struct {
	Type string
	Data []byte
}

func Status(printerHost string) (scanner, adf string) {
	scanner, adf = "unreachable", "unknown"
	resp, err := shortClient().Get("http://" + printerHost + "/eSCL/ScannerStatus")
	if err != nil {
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	text := string(body)
	if i := strings.Index(text, "<pwg:State>"); i >= 0 {
		rest := text[i+len("<pwg:State>"):]
		if j := strings.Index(rest, "</pwg:State>"); j >= 0 {
			scanner = rest[:j]
		}
	}
	if i := strings.Index(text, "<scan:AdfState>"); i >= 0 {
		rest := text[i+len("<scan:AdfState>"):]
		if j := strings.Index(rest, "</scan:AdfState>"); j >= 0 {
			adf = rest[:j]
		}
	}
	return
}

func PickSource(adf, requested string) (string, error) {
	switch requested {
	case "adf":
		if adf == "ScannerAdfEmpty" || strings.Contains(strings.ToLower(adf), "empty") {
			return "", fmt.Errorf("feeder is empty")
		}
		return "Feeder", nil
	case "platen":
		return "Platen", nil
	default:
		if adf != "" && adf != "ScannerAdfEmpty" && !strings.Contains(strings.ToLower(adf), "empty") {
			return "Feeder", nil
		}
		return "Platen", nil
	}
}

func Scan(printerHost, inputSource string) ([]Page, error) {
	height := A4Height
	if inputSource == "Feeder" {
		height = 4200
	}
	xml := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.6</pwg:Version>
  <scan:Intent>Document</scan:Intent>
  <pwg:ScanRegions>
    <pwg:MustHonor>true</pwg:MustHonor>
    <pwg:ScanRegion>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
      <pwg:Width>%d</pwg:Width>
      <pwg:Height>%d</pwg:Height>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>%s</pwg:InputSource>
  <pwg:DocumentFormat>application/pdf</pwg:DocumentFormat>
  <scan:ColorMode>RGB24</scan:ColorMode>
  <scan:XResolution>300</scan:XResolution>
  <scan:YResolution>300</scan:YResolution>
</scan:ScanSettings>
`, A4Width, height, inputSource)

	base := "http://" + printerHost
	req, err := http.NewRequest(http.MethodPost, base+"/eSCL/ScanJobs", bytes.NewReader([]byte(xml)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "text/xml")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 201 && resp.StatusCode != 200 {
		return nil, fmt.Errorf("scan job rejected (HTTP %d)", resp.StatusCode)
	}
	loc := resp.Header.Get("Location")
	if loc == "" {
		return nil, fmt.Errorf("scanner did not return a job URL")
	}
	if strings.HasPrefix(loc, "/") {
		loc = base + loc
	}
	docURL := strings.TrimRight(loc, "/") + "/NextDocument"
	var pages []Page
	for i := 0; i < MaxPages; i++ {
		r, err := client.Get(docURL)
		if err != nil {
			break
		}
		data, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode == 404 || len(data) == 0 {
			break
		}
		if r.StatusCode != 200 {
			return nil, fmt.Errorf("no scan data (HTTP %d) %s", r.StatusCode, string(body))
		}
		ctype := r.Header.Get("Content-Type")
		if ctype == "" {
			ctype = "application/pdf"
		}
		pages = append(pages, Page{Type: ctype, Data: data})
	}
	_, _ = http.NewRequest(http.MethodDelete, loc, nil)
	if len(pages) == 0 {
		return nil, fmt.Errorf("scanner returned no pages")
	}
	return pages, nil
}

func WritePDF(pages []Page) ([]byte, error) {
	if len(pages) == 1 && strings.Contains(pages[0].Type, "pdf") {
		return pages[0].Data, nil
	}
	var pdfs [][]byte
	for _, p := range pages {
		if strings.Contains(p.Type, "pdf") {
			pdfs = append(pdfs, p.Data)
			continue
		}
		return nil, fmt.Errorf("multi-page image merge needs a PDF from the printer; got %s", p.Type)
	}
	if len(pdfs) == 1 {
		return pdfs[0], nil
	}
	return pdfs[0], nil
}
