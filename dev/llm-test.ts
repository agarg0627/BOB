// Person D's local sandbox. Run with: npx tsx dev/llm-test.ts
import { generateFeature } from '../src/background/llm';

const prompts = [
  { prompt: 'hide youtube shorts', url: 'https://www.youtube.com/' },
  { prompt: 'make the background red', url: 'https://example.com/page' },
  { prompt: 'do something weird', url: 'https://news.ycombinator.com/' },
];

for (const { prompt, url } of prompts) {
  try {
    const res = await generateFeature({ prompt, url });
    console.log('---', prompt, '---');
    console.log('  name:', res.name);
    console.log('  desc:', res.description);
    console.log('  url :', res.urlPattern);
    console.log('  code:', res.code);

    // Syntax check: must not throw at construction
    new Function(res.code);
    console.log('  syntax: OK');
  } catch (e) {
    console.error('FAILED for', prompt, e);
  }
}

console.log('\nAll stubs validated.');
