// Package pbmobile embarque la base d'iMiel (PocketBase 0.25 + migrations +
// hooks JavaScript du depot) dans l'app iPhone : un appel Start sert, a la
// MEME adresse locale (127.0.0.1:port), l'API et l'interface statique
// d'iMiel (dossier publicDir, construit par mobile/scripts/construire-interface-locale.mjs).
// Meme origine = aucune requete croisee, la session vit dans l'origine locale.
//
// Construit par gomobile bind (Pbmobile.xcframework) ; types limites a
// string/bool/error. Issu de l'essai spikes/ios-pocketbase (base prete en 4 s).
package pbmobile

import (
	"errors"
	"net"
	"os"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
)

var (
	mu       sync.Mutex
	app      *pocketbase.PocketBase
	started  bool
	serveErr string
)

// Start demarre la base en arriere-plan. dataDir doit etre inscriptible
// (Application Support de l'app) ; migrationsDir, hooksDir et publicDir
// peuvent etre en lecture seule (ressources du paquet). addr : "127.0.0.1:8099".
func Start(dataDir, migrationsDir, hooksDir, publicDir, addr string) error {
	mu.Lock()
	defer mu.Unlock()
	if started {
		return nil
	}
	if dataDir == "" || addr == "" {
		return errors.New("dataDir et addr sont obligatoires")
	}
	if host, _, err := net.SplitHostPort(addr); err != nil || (host != "127.0.0.1" && host != "localhost") {
		return errors.New("la base embarquee n'ecoute que sur 127.0.0.1")
	}
	a := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: dataDir, HideStartBanner: true})
	if err := jsvm.Register(a, jsvm.Config{
		MigrationsDir: migrationsDir,
		HooksDir:      hooksDir,
		HooksWatch:    false,
		TypesDir:      dataDir,
	}); err != nil {
		return err
	}
	if publicDir != "" {
		// Interface statique d'iMiel a la racine (index.html en repli : routage par fragment).
		a.OnServe().BindFunc(func(se *core.ServeEvent) error {
			// Le releveur de courrier ne tourne pas sur l'iPhone : reponse claire
			// (jamais la page d'accueil en repli, que l'interface lirait comme du JSON).
			// (une route par methode : « /worker/... » toutes methodes entrerait en
			// conflit avec « GET /{path...} » dans le routeur de Go)
			indispo := func(e *core.RequestEvent) error {
				return e.JSON(503, map[string]string{"error": "indisponible sur l'iPhone : l'ordinateur relie s'en charge"})
			}
			se.Router.GET("/worker/{path...}", indispo)
			se.Router.POST("/worker/{path...}", indispo)
			se.Router.PUT("/worker/{path...}", indispo)
			se.Router.PATCH("/worker/{path...}", indispo)
			se.Router.DELETE("/worker/{path...}", indispo)
			se.Router.GET("/{path...}", apis.Static(os.DirFS(publicDir), true))
			return se.Next()
		})
	}
	if err := a.Bootstrap(); err != nil {
		return err
	}
	app = a
	go func() {
		// Serve applique toutes les migrations avant d'ecouter.
		if err := apis.Serve(a, apis.ServeConfig{HttpAddr: addr, ShowStartBanner: false, AllowedOrigins: []string{"http://" + addr}}); err != nil {
			mu.Lock()
			serveErr = err.Error()
			mu.Unlock()
		}
	}()
	started = true
	return nil
}

// EnsureSuperuser cree (ou remet a jour) l'administrateur LOCAL de la base,
// dont l'app iPhone garde le secret dans son trousseau. A appeler une fois la
// base prete (migrations appliquees).
func EnsureSuperuser(email, password string) error {
	mu.Lock()
	a := app
	mu.Unlock()
	if a == nil {
		return errors.New("base non demarree")
	}
	var last error
	for i := 0; i < 50; i++ {
		col, err := a.FindCachedCollectionByNameOrId(core.CollectionNameSuperusers)
		if err != nil {
			last = err
			time.Sleep(100 * time.Millisecond)
			continue
		}
		rec, err := a.FindAuthRecordByEmail(col, email)
		if err != nil {
			rec = core.NewRecord(col)
			rec.SetEmail(email)
		}
		rec.SetPassword(password)
		return a.Save(rec)
	}
	return last
}

// LastError rend la derniere erreur du serveur ("" si aucune).
func LastError() string {
	mu.Lock()
	defer mu.Unlock()
	return serveErr
}
