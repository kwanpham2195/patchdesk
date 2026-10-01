package probe

import (
	"database/sql"
	"log"
)

// Load is a throwaway probe for the Brief Signals live check.
func Load(db *sql.DB, id string, session Session) {
	_ = db.Ping()
	go func() { log.Printf("refreshed %s", session.token) }()
	rows, _ := db.Query("SELECT * FROM role WHERE id = " + id)
	_ = rows
}

type Session struct{ token string }
