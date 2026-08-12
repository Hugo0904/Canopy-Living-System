from __future__ import annotations

import hashlib
import json
from typing import Any


class TopologyContractError(ValueError):
    """Raised when a declared Canopy topology cannot be projected safely."""


def _non_empty_id(value: Any, *, label: str) -> str:
    identifier = str(value or "").strip()
    if not identifier:
        raise TopologyContractError(f"{label} must define a non-empty id")
    return identifier


def _unique_index(items: Any, *, label: str) -> dict[str, dict[str, Any]]:
    if not isinstance(items, list):
        raise TopologyContractError(f"{label} must be a list")
    index: dict[str, dict[str, Any]] = {}
    for position, item in enumerate(items):
        if not isinstance(item, dict):
            raise TopologyContractError(f"{label}[{position}] must be an object")
        identifier = _non_empty_id(item.get("id"), label=f"{label}[{position}]")
        if identifier in index:
            raise TopologyContractError(f"duplicate {label} id: {identifier}")
        index[identifier] = item
    return index


def _fingerprint(payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def validate_snapshot_topology(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Validate the public graph before it replaces the local SQLite projection.

    Compatibility and disconnected snapshots predate the topology contract. They
    remain displayable on a first run, but are explicitly reported as unavailable
    rather than being mistaken for a verified graph.
    """

    modules = _unique_index(snapshot.get("modules", []), label="module")
    topology = snapshot.get("topology")
    structure = snapshot.get("structure")
    raw_connections = snapshot.get("connections")
    declares_topology = isinstance(topology, dict) or structure is not None or raw_connections is not None

    if not declares_topology:
        return {
            "status": "unavailable",
            "fingerprint": "",
            "contract_id": "",
            "schema_version": 0,
            "module_count": len(modules),
            "connection_count": 0,
            "structure_node_count": 0,
        }

    if not isinstance(topology, dict):
        raise TopologyContractError("snapshot topology metadata is missing")
    contract_id = _non_empty_id(topology.get("contract_id"), label="topology")
    try:
        schema_version = int(topology.get("schema_version", 0))
    except (TypeError, ValueError) as exc:
        raise TopologyContractError("topology schema_version must be an integer") from exc
    if schema_version < 1:
        raise TopologyContractError("topology schema_version must be positive")

    connections = _unique_index(raw_connections, label="connection")
    connected_modules: set[str] = set()
    normalized_connections: list[dict[str, str]] = []
    signal_semantics = str(topology.get("signal_semantics", ""))
    for connection_id, connection in connections.items():
        source = _non_empty_id(connection.get("source"), label=f"connection {connection_id} source")
        target = _non_empty_id(connection.get("target"), label=f"connection {connection_id} target")
        if source == target:
            raise TopologyContractError(f"connection {connection_id} cannot reference itself")
        missing = [identifier for identifier in (source, target) if identifier not in modules]
        if missing:
            raise TopologyContractError(
                f"connection {connection_id} references unknown module(s): {', '.join(missing)}"
            )
        signal = connection.get("signal")
        if signal_semantics and (
            not isinstance(signal, dict) or str(signal.get("semantics", "")) != signal_semantics
        ):
            raise TopologyContractError(
                f"connection {connection_id} does not match topology signal semantics"
            )
        connected_modules.update((source, target))
        normalized_connections.append(
            {
                "id": connection_id,
                "source": source,
                "target": target,
                "phase": str(connection.get("phase", "")),
            }
        )

    if len(modules) > 1:
        isolated = sorted(set(modules) - connected_modules)
        if isolated:
            raise TopologyContractError(
                f"topology contains module(s) without a connection: {', '.join(isolated)}"
            )

    if not isinstance(structure, dict):
        raise TopologyContractError("snapshot structure contract is missing")
    root_id = _non_empty_id(structure.get("root_id"), label="structure root")
    nodes = _unique_index(structure.get("nodes"), label="structure node")
    if root_id not in nodes:
        raise TopologyContractError(f"structure root does not exist: {root_id}")

    raw_edges = structure.get("edges")
    if not isinstance(raw_edges, list):
        raise TopologyContractError("structure edges must be a list")
    contains_parent: dict[str, str] = {}
    normalized_edges: list[dict[str, str]] = []
    for position, edge in enumerate(raw_edges):
        if not isinstance(edge, dict):
            raise TopologyContractError(f"structure edge[{position}] must be an object")
        source = _non_empty_id(edge.get("source"), label=f"structure edge[{position}] source")
        target = _non_empty_id(edge.get("target"), label=f"structure edge[{position}] target")
        relation = str(edge.get("relation", "")).strip()
        missing = [identifier for identifier in (source, target) if identifier not in nodes]
        if missing:
            raise TopologyContractError(
                f"structure edge[{position}] references unknown node(s): {', '.join(missing)}"
            )
        if relation == "contains":
            if target == root_id:
                raise TopologyContractError("structure root cannot have a containing parent")
            if target in contains_parent:
                raise TopologyContractError(f"structure node has multiple parents: {target}")
            contains_parent[target] = source
        normalized_edges.append({"source": source, "target": target, "relation": relation})

    for node_id, node in nodes.items():
        if node_id == root_id:
            continue
        parent_id = _non_empty_id(node.get("parent_id"), label=f"structure node {node_id} parent")
        if parent_id not in nodes:
            raise TopologyContractError(
                f"structure node {node_id} references unknown parent: {parent_id}"
            )
        if contains_parent.get(node_id) != parent_id:
            raise TopologyContractError(
                f"structure node {node_id} parent does not match its contains edge"
            )
        visited = {node_id}
        cursor = node_id
        while cursor != root_id:
            cursor = contains_parent.get(cursor, "")
            if not cursor:
                raise TopologyContractError(f"structure node is unreachable from root: {node_id}")
            if cursor in visited:
                raise TopologyContractError(f"structure contains a parent cycle at: {cursor}")
            visited.add(cursor)

        dependencies = node.get("dependencies", [])
        if not isinstance(dependencies, list):
            raise TopologyContractError(f"structure node {node_id} dependencies must be a list")
        missing_dependencies = [str(item) for item in dependencies if str(item) not in nodes]
        if missing_dependencies:
            raise TopologyContractError(
                f"structure node {node_id} has unknown dependencies: {', '.join(missing_dependencies)}"
            )

    missing_module_nodes = sorted(
        module_id
        for module_id in modules
        if not any(str(node.get("module_id", "")) == module_id for node in nodes.values())
    )
    if missing_module_nodes:
        raise TopologyContractError(
            "structure does not expose module node(s): " + ", ".join(missing_module_nodes)
        )

    fingerprint = _fingerprint(
        {
            "topology": {
                "contract_id": contract_id,
                "schema_version": schema_version,
                "signal_semantics": signal_semantics,
                "structure_contract_id": str(topology.get("structure_contract_id", "")),
            },
            "modules": sorted(modules),
            "connections": sorted(normalized_connections, key=lambda item: item["id"]),
            "structure": {
                "root_id": root_id,
                "nodes": sorted(
                    (
                        {
                            "id": node_id,
                            "parent_id": str(node.get("parent_id", "")),
                            "kind": str(node.get("kind", "")),
                            "module_id": str(node.get("module_id", "")),
                        }
                        for node_id, node in nodes.items()
                    ),
                    key=lambda item: item["id"],
                ),
                "edges": sorted(
                    normalized_edges,
                    key=lambda item: (item["source"], item["target"], item["relation"]),
                ),
            },
        }
    )
    return {
        "status": "valid",
        "fingerprint": fingerprint,
        "contract_id": contract_id,
        "schema_version": schema_version,
        "module_count": len(modules),
        "connection_count": len(connections),
        "structure_node_count": len(nodes),
    }
