import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Message } from '../src/components/Message';

it('renders model text without scripts, embedded HTML, or remote tracking images', () => {
  const html = renderToStaticMarkup(<Message message={{ id: '1', role: 'assistant', kind: 'summary', status: 'complete', content: '<script>alert(1)</script>\n\n![track](https://evil.example/pixel)\n\n[click](javascript:alert(1))\n\n**A real summary**' }} />);
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('javascript:');
  expect(html).toContain('<strong>A real summary</strong>');
});
