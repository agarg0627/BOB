// Person D's local sandbox. Run with: npx tsx dev/llm-test.ts
import { generateFeature } from '../src/background/llm';

const prompts = [
  'hide youtube shorts',
  'make the background red',
  'do something weird',
];

for (const prompt of prompts) {
  try {
    const res = await generateFeature({ prompt, url: 'https://www.youtube.com/' });
    console.log('---', prompt, '---');
    console.log(res);
    new Function(res.code); // syntax check
  } catch (e) {
    console.error('failed for', prompt, e);
  }
}
