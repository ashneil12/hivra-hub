// Copyright coollabsio and the Orbit contributors
// SPDX-License-Identifier: Apache-2.0
// Source: https://github.com/coollabsio/orbit crates/platform/src/backup/reader.rs
//
// The SQLite half, translated to rusqlite (WP-75). Postgres `COPY` output is not
// included: Hivra's backups are one SQLite file. The connection is read-only and
// immutable, so opening a snapshot never writes to it.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::snapshot::{BackupError, Snapshot, DATABASE_FILE};

/// One row of a snapshot table: the selected columns, by name.
#[derive(Clone, Debug)]
pub struct SnapshotRow {
    columns: Arc<[String]>,
    values: Vec<Option<String>>,
}

impl SnapshotRow {
    /// The text of `column`; `None` for SQL `NULL` or a column that was not selected.
    #[must_use]
    pub fn get(&self, column: &str) -> Option<&str> {
        let index = self.columns.iter().position(|name| name == column)?;
        self.values[index].as_deref()
    }
}

#[derive(Debug)]
pub struct SnapshotReader {
    path: std::path::PathBuf,
}

impl SnapshotReader {
    /// A reader of `snapshot`, which the caller has verified. Nothing in the snapshot is written.
    pub fn open(snapshot: &Snapshot) -> Result<Self, BackupError> {
        let path = snapshot.path.join(DATABASE_FILE);
        if !path.is_file() {
            return Err(BackupError::InvalidSnapshot(
                "the snapshot has no SQLite database".into(),
            ));
        }
        Ok(Self { path })
    }

    /// The columns of `table`, or `None` when the snapshot has no such table.
    pub fn columns(&self, table: &str) -> Result<Option<Vec<String>>, BackupError> {
        let conn = connect(&self.path)?;
        let mut statement = conn
            .prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")
            .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
        let columns = statement
            .query_map([table], |row| row.get::<_, String>(0))
            .map_err(|error| BackupError::SnapshotRead(error.to_string()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
        Ok((!columns.is_empty()).then_some(columns))
    }

    /// The rows of `table` that `keep` accepts, with `columns` selected by name. A table or column the snapshot does
    /// not have is [`BackupError::InvalidSnapshot`]. Check an optional table with [`Self::columns`] first.
    pub fn rows<F>(
        &self,
        table: &str,
        columns: &[&str],
        mut keep: F,
    ) -> Result<Vec<SnapshotRow>, BackupError>
    where
        F: FnMut(&SnapshotRow) -> bool,
    {
        let available = self.columns(table)?.ok_or_else(|| {
            BackupError::InvalidSnapshot(format!("the snapshot has no table {table}"))
        })?;
        for column in columns {
            if !available.iter().any(|name| name == column) {
                return Err(BackupError::InvalidSnapshot(format!(
                    "table {table} of the snapshot has no column {column}"
                )));
            }
        }
        let names: Arc<[String]> = columns.iter().map(|column| (*column).to_owned()).collect();
        let sql = format!(
            "SELECT {} FROM {}",
            columns
                .iter()
                .map(|column| format!("CAST({} AS TEXT)", quote(column)))
                .collect::<Vec<_>>()
                .join(", "),
            quote(table)
        );
        let conn = connect(&self.path)?;
        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
        let mut rows = statement
            .query([])
            .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
        let mut kept = Vec::new();
        while let Some(row) = rows
            .next()
            .map_err(|error| BackupError::SnapshotRead(error.to_string()))?
        {
            let values = (0..columns.len())
                .map(|index| row.get::<_, Option<String>>(index))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
            let snapshot_row = SnapshotRow {
                columns: Arc::clone(&names),
                values,
            };
            if keep(&snapshot_row) {
                kept.push(snapshot_row);
            }
        }
        Ok(kept)
    }
}

/// `file:` URI with the path percent-encoded, so a space or a non-ascii name still opens.
fn file_uri(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = if text.starts_with('/') {
        text
    } else {
        format!("/{text}")
    };
    let mut uri = String::from("file:");
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' => {
                uri.push(byte as char);
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri.push_str("?mode=ro&immutable=1");
    uri
}

/// A read-only connection that never writes to the file (no journal, no WAL recovery).
fn connect(path: &Path) -> Result<Connection, BackupError> {
    let uri = file_uri(path);
    let conn = Connection::open_with_flags(
        uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
    conn.pragma_update(None, "query_only", "ON")
        .map_err(|error| BackupError::SnapshotRead(error.to_string()))?;
    Ok(conn)
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}
