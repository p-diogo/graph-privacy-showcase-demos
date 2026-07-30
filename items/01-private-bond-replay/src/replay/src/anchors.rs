//! The served anchor set: the query that asks for it, and the model it parses
//! into.
//!
//! Two rules shape this module.
//!
//! **Every query is block-pinned.** Without a pin, two honest indexers
//! legitimately disagree because they are at different head blocks, and the
//! consistency check would report noise as divergence. Pinning by block hash
//! also means a reorg cannot silently change what was compared.
//!
//! **Every query carries zero variables.** The gateway rebuilds the string it
//! forwards to indexers by re-serializing the parsed variables map, and that
//! map is a `HashMap` (toolshed `graphql::QueryVariables`), whose iteration
//! order is arbitrary. With two or more variables the forwarded bytes — and so
//! the `requestCID` the attestation signs — are not reproducible by the client
//! at all. Inlining every argument into the query text removes the problem
//! rather than working around it.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Collection page size. Chosen far above the demo's 8 leaves; the fetch path
/// fails closed if any collection comes back exactly this full, because a
/// truncated page would silently weaken the completeness check into "complete
/// as far as the first page".
pub const PAGE_LIMIT: usize = 1000;

/// Which block every query in a run is pinned to.
///
/// Hash pinning is preferred: a block number can be re-mined to different
/// contents by a reorg, so two answers "at block N" are only comparable if N's
/// hash is also fixed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BlockPinValue {
    Hash(String),
    Number(u64),
}

impl BlockPinValue {
    pub fn as_graphql(&self) -> String {
        match self {
            BlockPinValue::Hash(h) => format!("block: {{hash: \"{h}\"}}"),
            BlockPinValue::Number(n) => format!("block: {{number: {n}}}"),
        }
    }
}

/// The one-off query that resolves the block to pin everything else to.
pub fn meta_query() -> String {
    "{_meta{block{number hash}deployment hasIndexingErrors}}".to_string()
}

/// The audit query: the complete anchor surface at one pinned block.
///
/// Written as a single line with no variables so the request string is a pure
/// function of the pin, and therefore reproducible byte-for-byte by anyone
/// re-verifying the attestation.
pub fn audit_query(pin: &BlockPinValue) -> String {
    let b = pin.as_graphql();
    format!(
        "{{\
_meta({b}){{block{{number hash}}deployment hasIndexingErrors}}\
bonds({b},first:{PAGE_LIMIT}){{id address bondId leafCount nullifierCount}}\
commitments({b},first:{PAGE_LIMIT},orderBy:leafIndex,orderDirection:asc){{id leafIndex value sourceFunction txHash blockNumber timestamp caller}}\
nullifiers({b},first:{PAGE_LIMIT},orderBy:id,orderDirection:asc){{id value sourceFunction txHash blockNumber timestamp caller}}\
rootClaimeds({b},first:{PAGE_LIMIT},orderBy:id,orderDirection:asc){{id root sourceFunction txHash blockNumber timestamp}}\
lifecycleCalls({b},first:{PAGE_LIMIT},orderBy:id,orderDirection:asc){{id function leafCountAfter proofHash proofLength txHash blockNumber timestamp caller}}\
}}"
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MetaBlock {
    pub number: u64,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Meta {
    pub block: MetaBlock,
    #[serde(default)]
    pub deployment: String,
    #[serde(rename = "hasIndexingErrors", default)]
    pub has_indexing_errors: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BondEntity {
    pub id: String,
    pub address: String,
    #[serde(rename = "bondId")]
    pub bond_id: String,
    #[serde(rename = "leafCount")]
    pub leaf_count: String,
    #[serde(rename = "nullifierCount")]
    pub nullifier_count: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CommitmentEntity {
    pub id: String,
    #[serde(rename = "leafIndex")]
    pub leaf_index: String,
    pub value: String,
    #[serde(rename = "sourceFunction")]
    pub source_function: String,
    #[serde(rename = "txHash")]
    pub tx_hash: String,
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    pub timestamp: String,
    pub caller: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NullifierEntity {
    pub id: String,
    pub value: String,
    #[serde(rename = "sourceFunction")]
    pub source_function: String,
    #[serde(rename = "txHash")]
    pub tx_hash: String,
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    pub timestamp: String,
    pub caller: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RootClaimedEntity {
    pub id: String,
    pub root: String,
    #[serde(rename = "sourceFunction")]
    pub source_function: String,
    #[serde(rename = "txHash")]
    pub tx_hash: String,
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LifecycleCallEntity {
    pub id: String,
    pub function: String,
    #[serde(rename = "leafCountAfter")]
    pub leaf_count_after: String,
    #[serde(rename = "proofHash")]
    pub proof_hash: String,
    #[serde(rename = "proofLength")]
    pub proof_length: String,
    #[serde(rename = "txHash")]
    pub tx_hash: String,
    #[serde(rename = "blockNumber")]
    pub block_number: String,
    pub timestamp: String,
    pub caller: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AnchorSet {
    #[serde(rename = "_meta")]
    pub meta: Meta,
    pub bonds: Vec<BondEntity>,
    pub commitments: Vec<CommitmentEntity>,
    pub nullifiers: Vec<NullifierEntity>,
    #[serde(rename = "rootClaimeds")]
    pub roots_claimed: Vec<RootClaimedEntity>,
    #[serde(rename = "lifecycleCalls")]
    pub lifecycle_calls: Vec<LifecycleCallEntity>,
}

/// Parse a served GraphQL response body into the anchor set.
///
/// GraphQL errors are surfaced, not swallowed: a partial response with an
/// `errors` array must never be reconciled as if it were complete.
pub fn parse_anchor_set(body: &str) -> Result<AnchorSet> {
    let envelope: serde_json::Value =
        serde_json::from_str(body).context("served response is not valid JSON")?;

    if let Some(errors) = envelope.get("errors") {
        if !errors.is_null() && errors.as_array().map(|a| !a.is_empty()).unwrap_or(true) {
            bail!("served response carries GraphQL errors: {errors}");
        }
    }

    let data = envelope
        .get("data")
        .context("served response has no `data` field")?;

    let set: AnchorSet = serde_json::from_value(data.clone())
        .context("served response does not match the expected anchor-set shape")?;

    if set.meta.has_indexing_errors {
        bail!(
            "the serving deployment reports indexing errors (_meta.hasIndexingErrors); \
             its anchor log cannot be treated as complete"
        );
    }

    for (name, len) in [
        ("commitments", set.commitments.len()),
        ("nullifiers", set.nullifiers.len()),
        ("rootClaimeds", set.roots_claimed.len()),
        ("lifecycleCalls", set.lifecycle_calls.len()),
    ] {
        if len >= PAGE_LIMIT {
            bail!(
                "`{name}` returned {len} entries, at or above the {PAGE_LIMIT} page limit: the \
                 anchor set may be truncated and completeness cannot be claimed. Paged audit \
                 bundles are not implemented (see BUILD-REPORT.md)."
            );
        }
    }

    Ok(set)
}

impl AnchorSet {
    /// Served commitments in leaf order, with the ordering actually checked
    /// rather than assumed from `orderBy`.
    pub fn ordered_commitments(&self) -> Result<Vec<&CommitmentEntity>> {
        let mut by_index: BTreeMap<u64, &CommitmentEntity> = BTreeMap::new();

        for c in &self.commitments {
            let idx: u64 = c
                .leaf_index
                .parse()
                .with_context(|| format!("leafIndex is not a number: {}", c.leaf_index))?;
            if by_index.insert(idx, c).is_some() {
                bail!("two served commitments claim leaf index {idx}");
            }
        }

        for (position, idx) in by_index.keys().enumerate() {
            if *idx != position as u64 {
                bail!(
                    "served leaf indices are not contiguous from 0: expected {position}, found {idx}"
                );
            }
        }

        Ok(by_index.into_values().collect())
    }

    /// Running leaf totals after each anchor-appending call, taken from the
    /// served lifecycle log and ordered by call id (block, tx index, log
    /// position), which is how the mapping assigns it.
    pub fn leaf_counts_after_each_call(&self) -> Result<Vec<usize>> {
        let mut calls: Vec<&LifecycleCallEntity> = self.lifecycle_calls.iter().collect();
        calls.sort_by(|a, b| a.id.cmp(&b.id));

        let mut counts = Vec::with_capacity(calls.len());
        let mut previous = 0usize;

        for call in calls {
            let after: usize = call
                .leaf_count_after
                .parse()
                .with_context(|| format!("leafCountAfter is not a number: {}", call.leaf_count_after))?;
            if after < previous {
                bail!(
                    "served lifecycle log is not monotonic: call {} reports {after} leaves after {previous}",
                    call.id
                );
            }
            previous = after;
            counts.push(after);
        }

        Ok(counts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_query_is_a_pure_function_of_the_pin() {
        let pin = BlockPinValue::Number(42);
        assert_eq!(audit_query(&pin), audit_query(&BlockPinValue::Number(42)));
        assert_ne!(audit_query(&pin), audit_query(&BlockPinValue::Number(43)));
    }

    #[test]
    fn audit_query_carries_no_graphql_variables() {
        // The `$` sigil is the only way a GraphQL document references a
        // variable. Its absence is what makes the request string reproducible.
        let q = audit_query(&BlockPinValue::Hash("0xabc".into()));
        assert!(!q.contains('$'), "audit query must inline all arguments: {q}");
    }

    #[test]
    fn hash_pin_and_number_pin_differ() {
        assert!(audit_query(&BlockPinValue::Hash("0xdead".into())).contains("hash: \"0xdead\""));
        assert!(audit_query(&BlockPinValue::Number(7)).contains("number: 7"));
    }

    fn body_with(commitments: &str) -> String {
        format!(
            r#"{{"data":{{"_meta":{{"block":{{"number":10,"hash":"0xaa"}},"deployment":"Qm","hasIndexingErrors":false}},
            "bonds":[],"commitments":[{commitments}],"nullifiers":[],"rootClaimeds":[],"lifecycleCalls":[]}}}}"#
        )
    }

    fn commitment_json(idx: u64) -> String {
        format!(
            r#"{{"id":"{idx}","leafIndex":"{idx}","value":"0x0{idx}","sourceFunction":"MINT",
            "txHash":"0x1","blockNumber":"1","timestamp":"1","caller":"0x2"}}"#
        )
    }

    #[test]
    fn rejects_responses_carrying_graphql_errors() {
        let body = r#"{"errors":[{"message":"boom"}],"data":null}"#;
        assert!(parse_anchor_set(body).unwrap_err().to_string().contains("GraphQL errors"));
    }

    #[test]
    fn rejects_a_deployment_reporting_indexing_errors() {
        let body = r#"{"data":{"_meta":{"block":{"number":10,"hash":"0xaa"},"deployment":"Qm","hasIndexingErrors":true},
            "bonds":[],"commitments":[],"nullifiers":[],"rootClaimeds":[],"lifecycleCalls":[]}}"#;
        assert!(parse_anchor_set(body).unwrap_err().to_string().contains("indexing errors"));
    }

    #[test]
    fn detects_non_contiguous_leaf_indices() {
        let body = body_with(&format!("{},{}", commitment_json(0), commitment_json(2)));
        let set = parse_anchor_set(&body).unwrap();
        assert!(set
            .ordered_commitments()
            .unwrap_err()
            .to_string()
            .contains("not contiguous"));
    }

    #[test]
    fn accepts_a_contiguous_log_regardless_of_arrival_order() {
        let body = body_with(&format!("{},{}", commitment_json(1), commitment_json(0)));
        let set = parse_anchor_set(&body).unwrap();
        let ordered = set.ordered_commitments().unwrap();
        assert_eq!(ordered[0].leaf_index, "0");
        assert_eq!(ordered[1].leaf_index, "1");
    }
}
