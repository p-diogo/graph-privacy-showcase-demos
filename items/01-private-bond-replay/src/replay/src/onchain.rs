//! Reading the anchored state directly from a chain node.
//!
//! This is the leg that makes the whole exercise mean something. The served
//! anchor log is a claim by an indexer; `knownRoots` is what the contract
//! actually recorded. Reconciliation succeeds only when a root rebuilt from
//! the served log is one the chain already knew — so a serving layer that
//! alters the log fails here even if it signs its alteration flawlessly.
//!
//! The auditor points this at their own RPC endpoint. Nothing about this check
//! requires trusting us, the gateway, or the indexer.

use alloy::primitives::{Address, B256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::rpc::types::BlockId;
use alloy::sol;
use anyhow::{Context, Result};

sol! {
    #[sol(rpc)]
    interface IPrivateBond {
        function bondId() external view returns (bytes32);
        function commitments(uint256) external view returns (bytes32);
        function knownRoots(bytes32) external view returns (bool);
        function nullifiers(bytes32) external view returns (bool);
    }
}

pub struct ChainReader {
    provider: alloy::providers::DynProvider,
    contract: Address,
    /// Every read is pinned to one block, so a chain that advances mid-run
    /// cannot make an inconsistent set of answers look consistent.
    block: BlockId,
}

impl ChainReader {
    pub async fn connect(rpc_url: &str, contract: Address, block: BlockId) -> Result<Self> {
        let provider = ProviderBuilder::new()
            .connect(rpc_url)
            .await
            .with_context(|| format!("cannot connect to RPC at {rpc_url}"))?;

        Ok(ChainReader {
            provider: alloy::providers::DynProvider::new(provider),
            contract,
            block,
        })
    }

    fn instance(&self) -> IPrivateBond::IPrivateBondInstance<&alloy::providers::DynProvider> {
        IPrivateBond::new(self.contract, &self.provider)
    }

    pub async fn block_number(&self) -> Result<u64> {
        self.provider
            .get_block_number()
            .await
            .context("cannot read chain head")
    }

    pub async fn bond_id(&self) -> Result<B256> {
        self.instance()
            .bondId()
            .block(self.block)
            .call()
            .await
            .context("eth_call bondId() failed")
    }

    /// Is this root one the contract recorded?
    pub async fn is_known_root(&self, root: B256) -> Result<bool> {
        self.instance()
            .knownRoots(root)
            .block(self.block)
            .call()
            .await
            .with_context(|| format!("eth_call knownRoots({root}) failed"))
    }

    pub async fn is_nullifier_spent(&self, nullifier: B256) -> Result<bool> {
        self.instance()
            .nullifiers(nullifier)
            .block(self.block)
            .call()
            .await
            .with_context(|| format!("eth_call nullifiers({nullifier}) failed"))
    }

    pub async fn commitment_at(&self, index: u64) -> Result<B256> {
        self.instance()
            .commitments(alloy::primitives::U256::from(index))
            .block(self.block)
            .call()
            .await
            .with_context(|| format!("eth_call commitments({index}) failed"))
    }

    /// Read the whole commitment array by walking indices until the getter
    /// reverts (the contract exposes no length accessor).
    pub async fn read_all_commitments(&self, expected_max: u64) -> Result<Vec<B256>> {
        let mut out = Vec::new();
        for i in 0..=expected_max {
            match self.commitment_at(i).await {
                Ok(value) => out.push(value),
                // Out-of-bounds on a public array getter reverts; that is the
                // end of the array, not an error.
                Err(_) => break,
            }
        }
        Ok(out)
    }
}
