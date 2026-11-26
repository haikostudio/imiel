// essai lance pbmobile.Start sur l'ordinateur (meme code que l'iPhone) et
// verifie : base prete, administrateur local cree, interface servie a la
// meme adresse. Usage :
//   go run ./cmd/essai <dataDir> <migrationsDir> <hooksDir> <publicDir> <addr>
package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"imiel.local/mobilebase/pbmobile"
)

func main() {
	if len(os.Args) < 6 {
		fmt.Println("usage: essai dataDir migrationsDir hooksDir publicDir addr")
		os.Exit(2)
	}
	addr := os.Args[5]
	t0 := time.Now()
	if err := pbmobile.Start(os.Args[1], os.Args[2], os.Args[3], os.Args[4], addr); err != nil {
		fmt.Println("START ERROR:", err)
		os.Exit(1)
	}
	for i := 0; i < 600; i++ {
		r, err := http.Get("http://" + addr + "/api/health")
		if err == nil && r.StatusCode == 200 {
			fmt.Printf("HEALTH OK apres %d ms\n", time.Since(t0).Milliseconds())
			if err := pbmobile.EnsureSuperuser("admin@imiel.local", "essai-mot-de-passe-local"); err != nil {
				fmt.Println("SUPERUSER ERROR:", err)
				os.Exit(1)
			}
			fmt.Println("SUPERUSER OK")
			if os.Args[4] != "" {
				p, err := http.Get("http://" + addr + "/")
				if err != nil {
					fmt.Println("INTERFACE ERROR:", err)
					os.Exit(1)
				}
				b, _ := io.ReadAll(p.Body)
				fmt.Printf("INTERFACE %d %v\n", p.StatusCode, strings.Contains(string(b), "<html"))
			}
			select {}
		}
		if e := pbmobile.LastError(); e != "" {
			fmt.Println("SERVE ERROR:", e)
			os.Exit(1)
		}
		time.Sleep(100 * time.Millisecond)
	}
	fmt.Println("TIMEOUT")
	os.Exit(1)
}
