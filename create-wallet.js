import { Wallet } from 'ethers';

// Generate random wallet
const wallet = Wallet.createRandom();

console.log('=== NEW EVM WALLET ===');
console.log('Address:', wallet.address);
console.log('Private Key:', wallet.privateKey);
console.log('Mnemonic:', wallet.mnemonic.phrase);
console.log('');
console.log('⚠️  SAVE THESE SECURELY - NEVER SHARE PRIVATE KEY');
