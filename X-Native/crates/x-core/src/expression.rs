//! Expressions & Reactive Dependency Graph (Phase 0 / Phase 4)
//!
//! Pipeline:
//! Expression String -> Parser -> AST -> Type Checker -> Dependency Graph (with Cycle Detection) -> Evaluation.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq)]
pub enum ExprAst {
    Number(f64),
    String(String),
    Identifier(String),
    MemberAccess {
        object: Box<ExprAst>,
        property: String,
    },
    Binary {
        op: String,
        left: Box<ExprAst>,
        right: Box<ExprAst>,
    },
    Unary {
        op: String,
        operand: Box<ExprAst>,
    },
    Call {
        callee: String,
        args: Vec<ExprAst>,
    },
}

#[derive(Debug, Clone, Default)]
pub struct ExpressionDependencyGraph {
    /// Directed edge: `from_key` depends on `to_key`
    pub edges: HashMap<String, HashSet<String>>,
}

impl ExpressionDependencyGraph {
    pub fn new() -> Self {
        Self {
            edges: HashMap::new(),
        }
    }

    pub fn add_dependency(&mut self, from_key: &str, to_key: &str) {
        self.edges
            .entry(from_key.to_string())
            .or_default()
            .insert(to_key.to_string());
    }

    pub fn detect_cycle(&self, start_key: Option<&str>) -> Option<Vec<String>> {
        let mut visited = HashSet::new();
        let mut rec_stack = Vec::new();

        let nodes: Vec<String> = match start_key {
            Some(k) => vec![k.to_string()],
            None => self.edges.keys().cloned().collect(),
        };

        for node in nodes {
            if let Some(cycle) = self.dfs_check(&node, &mut visited, &mut rec_stack) {
                return Some(cycle);
            }
        }

        None
    }

    fn dfs_check(
        &self,
        node: &str,
        visited: &mut HashSet<String>,
        rec_stack: &mut Vec<String>,
    ) -> Option<Vec<String>> {
        if rec_stack.iter().any(|k| k == node) {
            let idx = rec_stack.iter().position(|k| k == node).unwrap();
            let mut cycle = rec_stack[idx..].to_vec();
            cycle.push(node.to_string());
            return Some(cycle);
        }

        if visited.contains(node) {
            return None;
        }

        visited.insert(node.to_string());
        rec_stack.push(node.to_string());

        if let Some(neighbors) = self.edges.get(node) {
            for next in neighbors {
                if let Some(cycle) = self.dfs_check(next, visited, rec_stack) {
                    return Some(cycle);
                }
            }
        }

        rec_stack.pop();
        None
    }
}
