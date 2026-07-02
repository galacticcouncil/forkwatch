import { LegacyTransaction, AccessListEIP2930Transaction, FeeMarketEIP1559Transaction } from '@ethereumjs/tx';

/**
 * extract trackable (signer, nonce, hash) tuples from a block's or the pending
 * pool's Vec<Extrinsic>. refHeight anchors mortal era decoding to the block
 * height at which these extrinsics were observed -- era only encodes a
 * phase/period pair, so a reference height is needed to resolve it into
 * absolute birth/death block numbers.
 *
 * whitelist (optional Set<address>) gates capture of the full raw signed
 * extrinsic bytes (ext.toHex()) -- only for signers on this list, so the
 * general population never pays the memory cost of retaining call data we
 * otherwise discard immediately. this is what a resubmission would replay
 * unmodified (no new signature involved).
 */
export function extractTrackedExtrinsics(extrinsics, refHeight, whitelist = null) {
	const results = [];
	for (const ext of extrinsics) {
		if (ext.isSigned) {
			results.push(extractSubstrateExtrinsic(ext, refHeight, whitelist));
		} else if (ext.method.section === 'ethereum' && ext.method.method === 'transact') {
			results.push(extractEvmExtrinsic(ext, whitelist));
		}
	}
	return results;
}

function extractSubstrateExtrinsic(ext, refHeight, whitelist) {
	let era = null;
	try {
		if (ext.era.isMortalEra) {
			const mortal = ext.era.asMortalEra;
			era = { birth: mortal.birth(refHeight), death: mortal.death(refHeight) };
		}
	} catch (e) {
		era = null;
	}

	const signer = ext.signer.toString();

	return {
		kind: 'substrate',
		signer,
		nonce: ext.nonce.toNumber(),
		hash: ext.hash.toHex(),
		section: ext.method.section,
		method: ext.method.method,
		era,
		raw: whitelist?.has(signer) ? ext.toHex() : null,
	};
}

/**
 * ethereum.transact extrinsics are unsigned at the substrate level -- the real
 * signature lives inside the wrapped TransactionV2. baseline identity is the
 * wrapper's own extrinsic hash (always available, zero decode risk); sender +
 * nonce recovery is a best-effort enhancement that degrades silently to the
 * baseline if it fails (e.g. an unrecognized TransactionV2 variant after a
 * runtime upgrade). no mortal era exists for ethereum transactions.
 */
function extractEvmExtrinsic(ext, whitelist) {
	const base = {
		kind: 'evm',
		signer: null,
		nonce: null,
		hash: ext.hash.toHex(),
		section: 'ethereum',
		method: 'transact',
		era: null,
		raw: null,
	};

	try {
		const recovered = recoverEvmSender(ext.method.args[0]);
		if (recovered) {
			base.signer = recovered.from;
			base.nonce = recovered.nonce;
			base.hash = recovered.hash;
		}
	} catch (e) {
		// sender recovery is best-effort -- fall back to wrapper-hash-only tracking
	}

	// whitelist matching (and therefore resubmission) for evm accounts depends
	// on sender recovery having succeeded above -- without a recovered address
	// there's nothing to check the whitelist against.
	if (base.signer && whitelist?.has(base.signer)) {
		base.raw = ext.toHex();
	}

	return base;
}

function recoverEvmSender(txV2) {
	const built = buildEthereumJsTx(txV2);
	if (!built) return null;
	const { tx, nonce } = built;
	const from = tx.getSenderAddress().toString();
	const hash = '0x' + Buffer.from(tx.hash()).toString('hex');
	return { from, nonce, hash };
}

function actionTo(action) {
	return action.isCall ? action.asCall.toHex() : undefined;
}

function buildEthereumJsTx(txV2) {
	if (txV2.isLegacy) {
		const t = txV2.asLegacy;
		const tx = LegacyTransaction.fromTxData({
			nonce: t.nonce.toBigInt(),
			gasPrice: t.gasPrice.toBigInt(),
			gasLimit: t.gasLimit.toBigInt(),
			to: actionTo(t.action),
			value: t.value.toBigInt(),
			data: t.input.toHex(),
			v: t.signature.v.toBigInt(),
			r: t.signature.r.toBigInt(),
			s: t.signature.s.toBigInt(),
		});
		return { tx, nonce: Number(t.nonce.toBigInt()) };
	}

	if (txV2.isEip2930) {
		const t = txV2.asEip2930;
		const tx = AccessListEIP2930Transaction.fromTxData({
			chainId: t.chainId.toBigInt(),
			nonce: t.nonce.toBigInt(),
			gasPrice: t.gasPrice.toBigInt(),
			gasLimit: t.gasLimit.toBigInt(),
			to: actionTo(t.action),
			value: t.value.toBigInt(),
			data: t.input.toHex(),
			accessList: t.accessList.map(a => [a.address.toHex(), a.storageKeys.map(k => k.toHex())]),
			v: t.oddYParity.isTrue ? 1n : 0n,
			r: t.r.toBigInt(),
			s: t.s.toBigInt(),
		});
		return { tx, nonce: Number(t.nonce.toBigInt()) };
	}

	if (txV2.isEip1559) {
		const t = txV2.asEip1559;
		const tx = FeeMarketEIP1559Transaction.fromTxData({
			chainId: t.chainId.toBigInt(),
			nonce: t.nonce.toBigInt(),
			maxPriorityFeePerGas: t.maxPriorityFeePerGas.toBigInt(),
			maxFeePerGas: t.maxFeePerGas.toBigInt(),
			gasLimit: t.gasLimit.toBigInt(),
			to: actionTo(t.action),
			value: t.value.toBigInt(),
			data: t.input.toHex(),
			accessList: t.accessList.map(a => [a.address.toHex(), a.storageKeys.map(k => k.toHex())]),
			v: t.oddYParity.isTrue ? 1n : 0n,
			r: t.r.toBigInt(),
			s: t.s.toBigInt(),
		});
		return { tx, nonce: Number(t.nonce.toBigInt()) };
	}

	return null;
}
