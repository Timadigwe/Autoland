import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

class KeyGenerator {
  private configPath: string;

  constructor() {
    this.configPath = path.join(__dirname, '..', 'config', 'private-keys.txt');
  }

  generateKeys(count: number): void {
    if (count <= 0) {
      console.error('Number of keys must be greater than 0');
      process.exit(1);
    }

    console.log(`Generating ${count} keypair(s)...\n`);

    const privateKeys: string[] = [];
    
    for (let i = 0; i < count; i++) {
      const keypair = Keypair.generate();
      const privateKey = keypair.secretKey;
      const publicKey = keypair.publicKey.toBase58();
      
      const privateKeyBase58 = this.uint8ArrayToBase58(privateKey);
      privateKeys.push(privateKeyBase58);
      
      console.log(`Keypair ${i + 1}:`);
      console.log(`  Public Key:  ${publicKey}`);
      console.log(`  Private Key: ${privateKeyBase58}`);
      console.log('');
    }

    this.savePrivateKeys(privateKeys);
    console.log(`✅ ${count} private key(s) saved to: ${this.configPath}`);
  }

  private uint8ArrayToBase58(uint8Array: Uint8Array): string {
    const bs58 = require('bs58');
    return bs58.encode(uint8Array);
  }

  private savePrivateKeys(privateKeys: string[]): void {
    const content = privateKeys.join('\n') + '\n';
    
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      fs.writeFileSync(this.configPath, content, 'utf8');
    } catch (error) {
      console.error('Error saving private keys:', error);
      process.exit(1);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: npm run generate-keys <number_of_keys>');
    console.error('Example: npm run generate-keys 5');
    process.exit(1);
  }

  const count = parseInt(args[0], 10);
  
  if (isNaN(count)) {
    console.error('Error: Please provide a valid number');
    process.exit(1);
  }

  const generator = new KeyGenerator();
  generator.generateKeys(count);
}

if (require.main === module) {
  main();
}
