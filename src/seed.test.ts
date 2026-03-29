import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseEventMetadata } from './seed.js';

describe('parseMarkdown', () => {
  it('splits paragraphs into separate chunks', () => {
    const md = `# Title

First paragraph here.

Second paragraph here.`;
    const chunks = parseMarkdown(md, 'faq.md');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('First paragraph here.');
    expect(chunks[1].text).toBe('Second paragraph here.');
  });

  it('prepends section headings as context', () => {
    const md = `# Spaces

## Kitchen
The kitchen is on the ground floor.

## Garden
The garden has a fire pit.`;
    const chunks = parseMarkdown(md, 'spaces.md');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe('Kitchen: The kitchen is on the ground floor.');
    expect(chunks[1].text).toBe('Garden: The garden has a fire pit.');
  });

  it('combines list items into one chunk per section', () => {
    const md = `# People

## Who's Here
- Alice — designer
- Marco — developer
- Jin — yoga teacher`;
    const chunks = parseMarkdown(md, 'people.md');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Alice');
    expect(chunks[0].text).toContain('Marco');
    expect(chunks[0].text).toContain('Jin');
  });

  it('sets metadata from filename', () => {
    const chunks = parseMarkdown('Some fact.', 'spaces.md');
    expect(chunks[0].metadata).toEqual({
      type: 'fact',
      topic: 'spaces',
      tier: 'operational',
      source_context: 'seed',
      source_file: 'spaces.md',
    });
  });

  it('sets social tier for norms', () => {
    const chunks = parseMarkdown('A norm.', 'norms.md');
    expect(chunks[0].metadata.type).toBe('norm');
    expect(chunks[0].metadata.tier).toBe('social');
  });

  it('skips HTML comments and short lines', () => {
    const md = `<!-- template placeholder -->
# Title

<!-- another comment -->

Hi.

Real content here.`;
    const chunks = parseMarkdown(md, 'faq.md');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Real content here.');
  });

  it('handles real-world spaces.md structure', () => {
    const md = `# Spaces

## The House
The main house has a shared kitchen, a living room with couches and a projector, and a garden out back. The front door code is 4821.

## Kitchen
The kitchen is on the ground floor of the main house. There's a fridge, stove, oven, and a Nespresso machine. Capsules are in the drawer under the machine. Please clean up after yourself.

## Co-working Room
Upstairs room with 6 desks and decent wifi. The wifi network is "emergentvibe" and the password is "coral2026". There's a whiteboard and markers.`;
    const chunks = parseMarkdown(md, 'spaces.md');
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text).toMatch('The House:');
    expect(chunks[1].text).toMatch('Kitchen:');
    expect(chunks[2].text).toMatch('Co-working Room:');
    expect(chunks[0].metadata.topic).toBe('spaces');
  });

  it('handles multi-paragraph sections', () => {
    const md = `# FAQ

## Wifi
The wifi network is "emergentvibe" and the password is "coral2026".

If it's slow, try the 5GHz network "emergentvibe-5G" (same password).`;
    const chunks = parseMarkdown(md, 'faq.md');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toContain('coral2026');
    expect(chunks[1].text).toContain('5GHz');
    // Both should have the heading context
    expect(chunks[0].text).toMatch('Wifi:');
    expect(chunks[1].text).toMatch('Wifi:');
  });
});

describe('parseEventMetadata', () => {
  it('extracts day of week', () => {
    const result = parseEventMetadata('Yoga class every Monday at the Garden');
    expect(result.day_of_week).toBe('Monday');
  });

  it('extracts time in 12h format', () => {
    const result = parseEventMetadata('Dinner at 7pm in the Main Hall');
    expect(result.time).toBe('7pm');
  });

  it('extracts time range', () => {
    const result = parseEventMetadata('Open mic 7pm-9pm at the Stage');
    expect(result.time).toBe('7pm-9pm');
  });

  it('extracts location after "at"', () => {
    const result = parseEventMetadata('Morning yoga at The Garden Pavilion');
    expect(result.location).toBe('The Garden Pavilion');
  });

  it('extracts recurrence patterns', () => {
    expect(parseEventMetadata('Happens every Tuesday').recurrence).toBe('every tuesday');
    expect(parseEventMetadata('Daily standup at 9am').recurrence).toBe('daily');
    expect(parseEventMetadata('Weekly sync on Friday').recurrence).toBe('weekly');
  });

  it('returns empty object for text without metadata', () => {
    const result = parseEventMetadata('Just a random note about the community');
    expect(result.day_of_week).toBeUndefined();
    expect(result.time).toBeUndefined();
    expect(result.location).toBeUndefined();
    expect(result.recurrence).toBeUndefined();
  });
});

describe('parseMarkdown with event metadata', () => {
  it('adds event metadata to chunks from events file', () => {
    const content = `# Schedule

## Morning

Yoga class every Monday at 7am at The Garden

## Evening

Open mic night on Friday at 8pm at The Stage
`;

    const chunks = parseMarkdown(content, 'events.md');

    const yoga = chunks.find((c) => c.text.includes('Yoga'));
    expect(yoga).toBeDefined();
    expect(yoga!.metadata.day_of_week).toBe('Monday');
    expect(yoga!.metadata.time).toBe('7am');
    expect(yoga!.metadata.location).toBe('The Garden');
    expect(yoga!.metadata.recurrence).toBe('every monday');

    const openMic = chunks.find((c) => c.text.includes('Open mic'));
    expect(openMic).toBeDefined();
    expect(openMic!.metadata.day_of_week).toBe('Friday');
    expect(openMic!.metadata.time).toBe('8pm');
  });

  it('does not add event metadata to non-event files', () => {
    const content = `## Kitchen

Open Monday-Friday at 7am at The Main Building
`;

    const chunks = parseMarkdown(content, 'spaces.md');
    expect(chunks[0].metadata.day_of_week).toBeUndefined();
    expect(chunks[0].metadata.topic).toBe('spaces');
  });

  it('maps introductions.md to introduction type', () => {
    const content = `## Members

Alice is into music production and photography
`;

    const chunks = parseMarkdown(content, 'introductions.md');
    expect(chunks[0].metadata.type).toBe('introduction');
    expect(chunks[0].metadata.topic).toBe('introductions');
    expect(chunks[0].metadata.tier).toBe('social');
  });
});
