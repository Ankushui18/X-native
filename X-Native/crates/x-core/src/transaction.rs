//! Canonical Command/Transaction System (Phase 0 Foundation)
//!
//! Every document mutation flows through explicit, atomic Transactions composed
//! of reversible Operations. This guarantees:
//! 1. Deterministic local Undo/Redo by inverting operations.
//! 2. Immutable transaction delta stream for Phase 6 CRDT sync.
//! 3. Single source of truth for Editor, Renderer, and Prototype runtime.

use serde::{Deserialize, Serialize};

pub type TransactionId = String;
pub type NodeId = String;
pub type VariableId = String;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Operation {
    SetProperty {
        target_id: NodeId,
        property: String,
        old_value: String,
        new_value: String,
    },
    InsertNode {
        parent_id: NodeId,
        node_id: NodeId,
        index: usize,
    },
    RemoveNode {
        parent_id: NodeId,
        node_id: NodeId,
        previous_index: usize,
    },
    MoveNode {
        node_id: NodeId,
        old_parent_id: NodeId,
        new_parent_id: NodeId,
        old_index: usize,
        new_index: usize,
    },
    SetVariable {
        variable_id: VariableId,
        old_value: String,
        new_value: String,
    },
    DeleteEdge {
        edge_id: String,
    },
    ApplyModifier {
        target_id: NodeId,
        modifier_json: String,
        index: usize,
    },
    RemoveModifier {
        target_id: NodeId,
        index: usize,
        previous_modifier_json: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransactionMetadata {
    pub label: Option<String>,
    pub author_id: Option<String>,
    pub origin: Option<String>, // "user", "script", "plugin", "sync"
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Transaction {
    pub id: TransactionId,
    pub timestamp: u64,
    pub operations: Vec<Operation>,
    pub metadata: Option<TransactionMetadata>,
}

impl Operation {
    /// Inverts the operation mathematically for deterministic undo.
    pub fn invert(&self) -> Self {
        match self {
            Operation::SetProperty {
                target_id,
                property,
                old_value,
                new_value,
            } => Operation::SetProperty {
                target_id: target_id.clone(),
                property: property.clone(),
                old_value: new_value.clone(),
                new_value: old_value.clone(),
            },
            Operation::InsertNode {
                parent_id,
                node_id,
                index,
            } => Operation::RemoveNode {
                parent_id: parent_id.clone(),
                node_id: node_id.clone(),
                previous_index: *index,
            },
            Operation::RemoveNode {
                parent_id,
                node_id,
                previous_index,
            } => Operation::InsertNode {
                parent_id: parent_id.clone(),
                node_id: node_id.clone(),
                index: *previous_index,
            },
            Operation::MoveNode {
                node_id,
                old_parent_id,
                new_parent_id,
                old_index,
                new_index,
            } => Operation::MoveNode {
                node_id: node_id.clone(),
                old_parent_id: new_parent_id.clone(),
                new_parent_id: old_parent_id.clone(),
                old_index: *new_index,
                new_index: *old_index,
            },
            Operation::SetVariable {
                variable_id,
                old_value,
                new_value,
            } => Operation::SetVariable {
                variable_id: variable_id.clone(),
                old_value: new_value.clone(),
                new_value: old_value.clone(),
            },
            Operation::DeleteEdge { edge_id } => Operation::DeleteEdge {
                edge_id: edge_id.clone(),
            },
            Operation::ApplyModifier {
                target_id,
                modifier_json,
                index,
            } => Operation::RemoveModifier {
                target_id: target_id.clone(),
                index: *index,
                previous_modifier_json: modifier_json.clone(),
            },
            Operation::RemoveModifier {
                target_id,
                index,
                previous_modifier_json,
            } => Operation::ApplyModifier {
                target_id: target_id.clone(),
                modifier_json: previous_modifier_json.clone(),
                index: *index,
            },
        }
    }
}

impl Transaction {
    /// Inverts the entire transaction.
    pub fn invert(&self) -> Self {
        let mut inverted_ops: Vec<Operation> = self
            .operations
            .iter()
            .rev()
            .map(|op| op.invert())
            .collect();

        Self {
            id: format!("inv_{}", self.id),
            timestamp: self.timestamp,
            operations: inverted_ops,
            metadata: Some(TransactionMetadata {
                label: self.metadata.as_ref().and_then(|m| m.label.as_ref()).map(|l| format!("Undo: {}", l)),
                author_id: self.metadata.as_ref().and_then(|m| m.author_id.clone()),
                origin: Some("history".to_string()),
            }),
        }
    }
}
