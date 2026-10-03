# CRDT Architecture for Collaborative Editing

**Status:** Planning / Architecture  
**Date:** 2026-09-14  
**Related:** [Figma's multiplayer architecture](https://www.figma.com/blog/tech-behind-figmas-real-time-collaboration/)

---

## Overview

X-Native currently uses a single-user data model with command-based undo/redo. To support collaborative editing (multiple users editing the same document simultaneously), we need a CRDT (Conflict-free Replicated Data Type) layer that allows concurrent edits to merge automatically without conflicts.

This document outlines the architectural approach for adding CRDT support to X-Native's existing command-based system.

---

## Current Architecture

### Single-User Model
- **Commands**: All edits go through `Command` enum (`Insert`, `Delete`, `Reorder`, `Group`, `Move`, etc.)
- **Undo/Redo**: Linear history stack with `undo_stack` and `redo_stack`
- **State**: Single `Document` with `pages: Vec<Node>`, `variables: Variables`
- **Persistence**: `.x` files (JSON), Figma `.fig` binary, Sketch, SVG import/export

### Limitations
1. **No conflict resolution**: Two users editing simultaneously would corrupt the document
2. **No presence**: Can't see where other users are editing
3. **No operational transformation**: Commands are not designed for distributed systems
4. **No vector clocks**: No way to track causal ordering of edits

---

## Proposed CRDT Architecture

### Design Principles

1. **Command Compatibility**: Existing `Command` enum should remain the primary API
2. **Eventual Consistency**: All replicas converge to the same state
3. **Causal Ordering**: Operations respect Lamport timestamps / vector clocks
4. **Tombstones**: Deleted nodes are marked (not removed) to allow late-arriving operations
5. **Idempotency**: Applying the same operation twice has no additional effect

### CRDT Type Selection

X-Native's document model maps to several CRDT types:

| X-Native Type | CRDT Type | Rationale |
|---------------|-----------|-----------|
| `Document` | **LWW-Map** (Last-Writer-Wins Map) | Top-level container with unique IDs |
| `Node` tree | **Tree CRDT** (RGA / Loro Tree) | Hierarchical structure with move operations |
| `children: Vec<Node>` | **RGA** (Replicated Growable Array) | Ordered list with insert/delete/move |
| `Node::w`, `h`, `x`, `y` | **LWW-Register** | Single-value properties with timestamps |
| `Node::fill`, `stroke` | **LWW-Register** | Property values with timestamps |
| `Variables` | **LWW-Map** | Key-value store with unique variable IDs |
| `Text::runs` | **RGA** | Ordered list of text spans |

### Operation Model

Every user action generates a **CRDT Operation**:

```rust
pub struct CrdtOp {
    pub id: OpId,              // Unique operation identifier
    pub site_id: SiteId,       // Originating site (user/device)
    pub lamport_ts: LamportTs, // Logical timestamp
    pub vector_clock: VClock,  // Causal dependency tracking
    pub payload: OpPayload,    // The actual operation
}

pub enum OpPayload {
    // Node lifecycle
    InsertNode { parent_id: NodeId, index: usize, node: NodeSnapshot },
    DeleteNode { node_id: NodeId },
    MoveNode { node_id: NodeId, new_parent: NodeId, new_index: usize },
    
    // Property updates
    SetNodeProperty { node_id: NodeId, property: PropertyKey, value: PropertyValue },
    
    // Variable updates
    SetVariable { var_id: VarId, value: VarValue },
    DeleteVariable { var_id: VarId },
    
    // Batch operations (for undo/redo grouping)
    BeginGroup { group_id: GroupId },
    EndGroup { group_id: GroupId },
}
```

### Integration with Command System

**Phase 1: Command → Op Translation**

Each `Command` maps to one or more `CrdtOp`s:

```rust
impl Command {
    pub fn to_crdt_ops(&self, state: &Document) -> Vec<CrdtOp> {
        match self {
            Command::Insert { parent, index, nodes } => {
                nodes.iter().enumerate().map(|(i, node)| {
                    CrdtOp::insert_node(parent, index + i, node.clone())
                }).collect()
            }
            Command::Delete { nodes } => {
                nodes.iter().map(|id| CrdtOp::delete_node(*id)).collect()
            }
            // ... other commands
        }
    }
}
```

**Phase 2: Op → Command Inverse**

For undo/redo, we need to generate inverse operations:

```rust
impl CrdtOp {
    pub fn inverse(&self, state: &Document) -> Option<CrdtOp> {
        match self {
            CrdtOp::InsertNode { parent_id, index, node } => {
                Some(CrdtOp::delete_node(node.id))
            }
            CrdtOp::DeleteNode { node_id } => {
                // Need to reconstruct the deleted node from tombstone
                state.tombstones.get(node_id).map(|tombstone| {
                    CrdtOp::insert_node(tombstone.parent, tombstone.index, tombstone.node.clone())
                })
            }
            // ... other operations
        }
    }
}
```

---

## Network Protocol

### Transport Layer

**WebSocket + Binary Protocol** (like Figma):

```rust
pub struct SyncMessage {
    pub session_id: SessionId,
    pub sequence: u64,
    pub ops: Vec<CrdtOp>,
    pub ack: Option<u64>, // Acknowledge received ops
}
```

### Sync Protocol

1. **Initial Sync**: New client receives full document state + operation log
2. **Incremental Sync**: Clients send/receive `CrdtOp`s in real-time
3. **Conflict Resolution**: CRDT guarantees convergence; no manual conflict resolution needed
4. **Compaction**: Periodically snapshot state and prune old operations

---

## Implementation Phases

### Phase 1: CRDT Core (No Network)
- [ ] Implement tree CRDT for `Node` hierarchy
- [ ] Implement LWW registers for node properties
- [ ] Implement RGA for `children` arrays
- [ ] Add tombstone tracking for deleted nodes
- [ ] Implement operation log with vector clocks
- [ ] Add `apply_op(&mut Document, &CrdtOp)` method
- [ ] Update `Command` system to emit `CrdtOp`s

### Phase 2: Local Collaboration (Multi-Window)
- [ ] Multiple editor windows sharing same document
- [ ] Each window is a separate "site" with its own `SiteId`
- [ ] Operations broadcast between windows via in-memory channel
- [ ] Verify convergence: all windows show identical state
- [ ] Add undo/redo that respects remote operations

### Phase 3: Network Layer
- [ ] WebSocket server for real-time sync
- [ ] Client reconnection and state recovery
- [ ] Operation buffering for offline edits
- [ ] Server-side operation log for persistence
- [ ] Authentication and authorization

### Phase 4: Presence & Cursors
- [ ] Remote cursor positions (broadcast every 100ms)
- [ ] User selection highlights
- [ ] Typing indicators for text editing
- [ ] User avatars and names
- [ ] "Following" mode (view what another user sees)

### Phase 5: Performance Optimization
- [ ] Operation batching (send multiple ops in one message)
- [ ] State snapshots (reduce operation log size)
- [ ] Lazy loading (only sync visible pages)
- [ ] Delta compression for property updates
- [ ] Garbage collection for tombstones

---

## Key Challenges

### 1. Move Operations
Moving a node in a tree CRDT is complex because it involves:
- Removing from old parent's children array
- Inserting into new parent's children array
- Preserving causal ordering

**Solution**: Use a **move-aware tree CRDT** (e.g., Loro's move semantics or Yjs's relative positions).

### 2. Undo/Redo with Remote Operations
If user A undoes an operation, but user B has since edited the same node, what happens?

**Solution**: 
- **Option A**: Undo only local operations (simpler, but may not feel "correct")
- **Option B**: Undo generates inverse operations that respect remote state (complex, but more intuitive)

Figma uses Option A: undo only affects your own operations.

### 3. Large Documents
Syncing a 10,000-node document on every connect is slow.

**Solution**:
- **Lazy loading**: Only sync visible pages initially
- **Incremental sync**: Send only operations since last sync
- **Snapshots**: Periodically compact the operation log

### 4. Text Editing
Text editing requires character-level CRDTs (like Yjs's `Y.Text` or Automerge's text CRDT).

**Solution**: Use a dedicated text CRDT for `Text::content` and `Text::runs`.

---

## Comparison with Existing CRDT Libraries

| Library | Pros | Cons | Recommendation |
|---------|------|------|----------------|
| **Yjs** | Mature, fast, good text support | JavaScript-first, Rust bindings incomplete | ⚠️ Consider for text only |
| **Automerge** | Pure Rust, good docs | Slower than Yjs, less battle-tested | ✅ Strong candidate |
| **Loro** | Rust-native, tree CRDT, fast | Newer, smaller community | ✅ Best fit for tree structure |
| **Diamond Types** | Fast, research-backed | Less feature-complete | ⚠️ Monitor development |

**Recommended**: **Loro** for the tree/document structure (native Rust, tree CRDT built-in), with **Yjs-compatible text CRDT** for text editing if needed.

---

## Testing Strategy

### Convergence Tests
- Generate random operations on 5+ replicas
- Apply operations in different orders
- Verify all replicas converge to identical state

### Performance Tests
- Measure sync latency (target: <100ms for 95th percentile)
- Measure memory usage (target: <50MB for 10,000-node document)
- Measure CPU usage during sync (target: <5% on modern CPU)

### Conflict Tests
- Simulate concurrent edits to the same node
- Verify no data loss or corruption
- Verify visual consistency across replicas

---

## Migration Path

### Backward Compatibility
- Existing `.x` files remain valid (no schema changes)
- `Command` API unchanged (operations are still commands)
- Undo/redo still works locally (even without network)

### Feature Flags
```rust
pub struct Document {
    // ... existing fields
    #[cfg(feature = "collaborative")]
    pub crdt_state: Option<CrdtState>,
    
    #[cfg(feature = "collaborative")]
    pub site_id: Option<SiteId>,
}
```

### Rollout Plan
1. **Internal testing**: Single-user with CRDT enabled (verify no regressions)
2. **Beta**: Multi-window collaboration (local network)
3. **Public**: Networked collaboration (WebSocket server)

---

## References

- [Figma's multiplayer architecture](https://www.figma.com/blog/tech-behind-figmas-real-time-collaboration/)
- [Loro CRDT library](https://loro.dev/)
- [Automerge](https://automerge.org/)
- [Yjs](https://docs.yjs.dev/)
- [CRDTs: The Hard Parts](https://www.youtube.com/watch?v=x7drE24geAM) (video)
- [Moving Elements in List CRDTs](https://arxiv.org/abs/2205.01636) (paper)

---

## Conclusion

Adding CRDT support to X-Native is a significant architectural change, but it's achievable in phases without breaking the existing command-based system. The key is to:

1. **Start with local multi-window collaboration** (proves the CRDT layer works)
2. **Use Loro for tree structure** (Rust-native, tree CRDT built-in)
3. **Keep the Command API unchanged** (existing code continues to work)
4. **Add network layer last** (once the CRDT core is battle-tested)

This approach minimizes risk and allows incremental validation at each phase.
