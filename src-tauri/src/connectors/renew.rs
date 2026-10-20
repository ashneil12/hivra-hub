//! Renewing an OAuth login when several connector processes hold it at once (one per session, plus the Test button).
//!
//! Providers that rotate refresh tokens accept each one once; a reused one fails, and some revoke the whole login. So a
//! renewal takes the connector's lock (`<data>/connector-locks/<id>.lock`, held across processes), reads the login from
//! the Keychain again inside it, and spends the refresh token only if the stored login is still the one this process
//! holds. If another process already renewed it, that renewal is taken instead.

use super::oauth;
use super::secrets::{Login, SecretStore};
use std::fs::OpenOptions;
use std::path::Path;

/// Run `work` holding connector `id`'s renewal lock (blocking until any other process lets it go).
fn locked<T>(dir: &Path, id: &str, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let folder = dir.join("connector-locks");
    std::fs::create_dir_all(&folder)
        .map_err(|_| "Couldn't make the connector lock folder.".to_string())?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(folder.join(format!("{id}.lock")))
        .map_err(|_| "Couldn't open the connector's lock.".to_string())?;
    file.lock()
        .map_err(|_| "Couldn't take the connector's lock.".to_string())?;
    let out = work();
    let _ = file.unlock();
    out
}

fn tokens(login: &Login) -> Option<(&str, Option<&str>)> {
    login
        .oauth
        .as_ref()
        .map(|t| (t.access_token.as_str(), t.refresh_token.as_deref()))
}

/// The login to use now, in place of `held` (whose access token expired or was refused): the one another process already
/// renewed, or a fresh renewal, kept in the store before it is used.
pub fn renew(dir: &Path, store: &dyn SecretStore, id: &str, held: &Login) -> Result<Login, String> {
    locked(dir, id, || {
        let stored = store.get(id)?.unwrap_or_else(|| held.clone());
        let renewed_elsewhere = tokens(&stored) != tokens(held);
        if renewed_elsewhere && stored.oauth.as_ref().is_some_and(|t| !oauth::expiring(t)) {
            return Ok(stored);
        }
        let current = stored
            .oauth
            .as_ref()
            .ok_or("The login has no OAuth token.")?;
        let fresh = oauth::refresh(current)?;
        let mut login = stored;
        login.oauth = Some(fresh);
        store.put(id, &login).map_err(|why| {
            format!("The renewed login couldn't be saved ({why}). Sign in again.")
        })?;
        Ok(login)
    })
}
