import { extractTrackedExtrinsics } from '../src/monitor/extrinsic-utils.js';

// H256 shape (signature r/s, block hashes, etc.) -- deliberately exposes ONLY
// toHex()/toU8a(), matching polkadot.js's real U8aFixed/Raw codec. This is the
// exact shape that made the historical bug (.toBigInt() called on r/s) throw
// unconditionally -- these mocks intentionally do NOT define toBigInt(), so a
// regression back to that bug would make the "real signed tx" tests below fail.
function h256(hex) {
	return { toHex: () => hex };
}

function numericField(n) {
	return { toBigInt: () => BigInt(n), toNumber: () => Number(n) };
}

function substrateTx({ signer = '5Grw...alice', nonce = 5, hash = '0xaaa', section = 'balances', method = 'transfer', mortal = null } = {}) {
	return {
		isSigned: true,
		signer: { toString: () => signer },
		nonce: numericField(nonce),
		hash: { toHex: () => hash },
		method: { section, method },
		era: mortal
			? { isMortalEra: true, asMortalEra: { birth: (h) => mortal.birth, death: (h) => mortal.death } }
			: { isMortalEra: false },
		toHex: () => '0xrawsubstrate',
	};
}

function evmExt(txV2, wrapperHash = '0xwrapper') {
	return {
		isSigned: false,
		method: { section: 'ethereum', method: 'transact', args: [txV2] },
		hash: { toHex: () => wrapperHash },
		toHex: () => '0xrawevm',
	};
}

// real signed legacy tx, generated with @ethereumjs/tx itself against a known
// test private key -- nonce=9, sender=0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f
function legacyTxV2() {
	return {
		isLegacy: true,
		isEip2930: false,
		isEip1559: false,
		asLegacy: {
			nonce: numericField(9),
			gasPrice: numericField(20000000000n),
			gasLimit: numericField(21000),
			action: { isCall: true, asCall: { toHex: () => '0x3535353535353535353535353535353535353535' } },
			value: numericField(1000000000000000000n),
			input: { toHex: () => '0x' },
			signature: {
				v: numericField(37),
				r: h256('0x28ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276'),
				s: h256('0x67cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83'),
			},
		},
	};
}

// real signed EIP-1559 tx, same test private key -- nonce=5, same sender
function eip1559TxV2() {
	return {
		isLegacy: false,
		isEip2930: false,
		isEip1559: true,
		asEip1559: {
			chainId: numericField(1284),
			nonce: numericField(5),
			maxPriorityFeePerGas: numericField(1000000000n),
			maxFeePerGas: numericField(30000000000n),
			gasLimit: numericField(21000),
			action: { isCall: true, asCall: { toHex: () => '0x3535353535353535353535353535353535353535' } },
			value: numericField(2000000000000000000n),
			input: { toHex: () => '0x' },
			accessList: [],
			oddYParity: { isTrue: false },
			r: h256('0xad0ee1c462cb39e88ae549eacc0adafd38a437d7c6aa2b304650541577305cbb'),
			s: h256('0x54c77c3b71796a04e1ae1020b7b10610613582a855f81d814ba4a33feca71ca9'),
		},
	};
}

describe('extractTrackedExtrinsics', () => {
	describe('substrate signed extrinsics', () => {
		test('extracts signer, nonce, hash, section, method', () => {
			const [result] = extractTrackedExtrinsics([substrateTx()], 100);
			expect(result).toMatchObject({
				kind: 'substrate', signer: '5Grw...alice', nonce: 5, hash: '0xaaa',
				section: 'balances', method: 'transfer', era: null, raw: '0xrawsubstrate',
			});
		});

		test('decodes a mortal era into absolute birth/death heights', () => {
			const [result] = extractTrackedExtrinsics([substrateTx({ mortal: { birth: 90, death: 154 } })], 100);
			expect(result.era).toEqual({ birth: 90, death: 154 });
		});

		test('immortal extrinsics have a null era', () => {
			const [result] = extractTrackedExtrinsics([substrateTx()], 100);
			expect(result.era).toBeNull();
		});

		test('ignores unsigned, non-ethereum extrinsics (inherents)', () => {
			const inherent = { isSigned: false, method: { section: 'timestamp', method: 'set' } };
			expect(extractTrackedExtrinsics([inherent], 100)).toEqual([]);
		});

		test('a single malformed extrinsic does not lose the rest of the batch', () => {
			const broken = { isSigned: true, signer: null }; // .toString() etc. would throw
			const good = substrateTx();
			const results = extractTrackedExtrinsics([broken, good], 100);
			expect(results).toHaveLength(1);
			expect(results[0].hash).toBe('0xaaa');
		});
	});

	describe('evm (ethereum.transact) -- regression coverage for the H256 .toBigInt() bug', () => {
		test('recovers the correct sender and nonce from a real signed legacy transaction', () => {
			const [result] = extractTrackedExtrinsics([evmExt(legacyTxV2())], 100);
			expect(result.kind).toBe('evm');
			expect(result.signer).toBe('0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f');
			expect(result.nonce).toBe(9);
			expect(result.era).toBeNull();
		});

		test('recovers the correct sender and nonce from a real signed EIP-1559 transaction', () => {
			const [result] = extractTrackedExtrinsics([evmExt(eip1559TxV2())], 100);
			expect(result.kind).toBe('evm');
			expect(result.signer).toBe('0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f');
			expect(result.nonce).toBe(5);
		});

		test('falls back to wrapper-hash-only tracking when sender recovery fails', () => {
			const brokenTxV2 = {
				isLegacy: true,
				asLegacy: { ...legacyTxV2().asLegacy, signature: { v: numericField(37), r: {}, s: {} } },
			};
			const [result] = extractTrackedExtrinsics([evmExt(brokenTxV2, '0xwrapperhash')], 100);
			expect(result.kind).toBe('evm');
			expect(result.signer).toBeNull();
			expect(result.nonce).toBeNull();
			expect(result.hash).toBe('0xwrapperhash');
		});

		test('an unrecognized TransactionV2 variant falls back gracefully', () => {
			const unknownTxV2 = { isLegacy: false, isEip2930: false, isEip1559: false };
			const [result] = extractTrackedExtrinsics([evmExt(unknownTxV2, '0xwrapperhash')], 100);
			expect(result.signer).toBeNull();
			expect(result.hash).toBe('0xwrapperhash');
		});
	});
});
