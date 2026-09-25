//! Plugin & Extensibility Architecture (Phase 0 / Section 4.K)
//!
//! Sandboxed boundary definitions for third-party extensions.

use crate::transaction::Transaction;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PluginError {
    PermissionDenied(String),
    InvalidTransaction(String),
    ExecutionError(String),
    Timeout,
}

pub trait PluginAPI {
    fn read_document_json(&self) -> Result<String, PluginError>;
    fn mutate(&self, transaction: Transaction) -> Result<(), PluginError>;
    fn register_ui(&self, component_id: &str) -> Result<(), PluginError>;
}
