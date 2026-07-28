/**
 * Step 18 — the one card renderer.
 *
 * The load-bearing test here is L2: catalog and play must render identically. It is asserted by
 * comparing outerHTML across two different containers, because the failure it guards against is
 * someone adding a second "play card" component (or a size prop) six screens from now.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { generateRulesProse } from '../../engine/prose';
import type { CardIndex, CardInstance, CardTemplate } from '../../engine/types';
import { CANTRIP, GRUNT, POWER, STRIKE, duel } from '../../test/fixtures/duel';
import { jitter } from '../../theme/jitter';
import { Card } from './Card';

const templateOf = (id: string): CardTemplate => duel.templates.find((t) => t.id === id)!;

const strike = templateOf(STRIKE);
const grunt = templateOf(GRUNT);

const instanceOf = (template: CardTemplate, over: Partial<CardInstance> = {}): CardInstance => ({
  id: 'c1',
  templateId: template.id,
  indexValues: {},
  faceDown: false,
  rotated: false,
  tags: [...template.tags],
  owner: 0,
  controller: null,
  attachedTo: null,
  ...over,
});

const withFlag = (template: CardTemplate, index: Partial<CardIndex> = {}): CardTemplate => ({
  ...template,
  indexes: [
    {
      id: 'idx_tapped',
      value: { type: 'boolean', name: 'Tapped', defaultValue: false },
      icon: 'gi-cycle',
      position: 'topRight',
      ...index,
    },
  ],
});

describe('the six layers (§6.3)', () => {
  it('renders border, marquee, face, tagline, rules and pips', () => {
    const { container } = render(<Card template={grunt} definition={duel} />);

    expect(container.querySelector('.cb-card__rough')).toBeInTheDocument();
    expect(container.querySelector('.cb-card__marquee')).toHaveTextContent(grunt.marquee);
    expect(container.querySelector('.cb-card__face use')).toHaveAttribute(
      'href',
      `#${grunt.faceIcon}`
    );
    expect(container.querySelector('.cb-card__tagline')).toHaveTextContent(grunt.tags.join(' · '));
    expect(container.querySelector('.cb-card__rules')).not.toBeEmptyDOMElement();
    expect(container.querySelectorAll('.cb-card__pips .cb-pip')).toHaveLength(1);
  });

  it('keeps the full tag list in title, since the tagline ellipsises and hides below 88px', () => {
    const many = { ...grunt, tags: ['creature', 'goblin', 'token', 'summer set'] };
    const { container } = render(<Card template={many} definition={duel} />);
    expect(container.querySelector('.cb-card__tagline')).toHaveAttribute(
      'title',
      'creature · goblin · token · summer set'
    );
  });

  it('carries the border colour and a deterministic tilt as custom properties', () => {
    const { container } = render(<Card template={grunt} definition={duel} />);
    const card = container.querySelector<HTMLElement>('.cb-card')!;
    expect(card.style.getPropertyValue('--cb-card-border')).toBe(grunt.borderColor);
    expect(card.style.getPropertyValue('--cb-jitter')).toBe(jitter(grunt.id));
  });

  it('tilts by the instance id once there is an instance, so a card keeps its own angle', () => {
    const { container } = render(
      <Card template={grunt} instance={instanceOf(grunt, { id: 'c42' })} definition={duel} />
    );
    expect(
      container.querySelector<HTMLElement>('.cb-card')!.style.getPropertyValue('--cb-jitter')
    ).toBe(jitter('c42'));
  });
});

describe('rules text (AC: A3)', () => {
  it('generates prose from the attached rule sets', () => {
    const { container } = render(<Card template={strike} definition={duel} />);
    const expected = generateRulesProse(
      duel.ruleSets.filter((rs) => strike.ruleSetIds.includes(rs.id)),
      duel
    );
    expect(expected).not.toBe('');
    expect(container.querySelector('.cb-card__rules')).toHaveTextContent(expected);
  });

  it('renders the override verbatim and leaves the rule sets untouched', () => {
    const overridden = { ...strike, rulesTextOverride: 'Deal 3 damage to any target.' };
    const before = structuredClone(duel.ruleSets);

    const { container } = render(<Card template={overridden} definition={duel} />);

    expect(container.querySelector('.cb-card__rules')).toHaveTextContent(
      'Deal 3 damage to any target.'
    );
    expect(container.querySelector('.cb-card__rules')).not.toHaveTextContent('When ');
    expect(duel.ruleSets).toEqual(before);
  });

  it('renders an empty rules layer for a card with no rules, not the string "undefined"', () => {
    const plain = { ...strike, ruleSetIds: [] };
    const { container } = render(<Card template={plain} definition={duel} />);
    expect(container.querySelector('.cb-card__rules')).toBeEmptyDOMElement();
  });

  it('ignores a ruleSetId that no longer resolves instead of crashing the table', () => {
    const dangling = { ...strike, ruleSetIds: [...strike.ruleSetIds, 'rs_deleted'] };
    const { container } = render(<Card template={dangling} definition={duel} />);
    expect(container.querySelector('.cb-card__rules')).toHaveTextContent('When ');
  });
});

describe('pips', () => {
  it('shows the instance value, not the template default', () => {
    const { container } = render(
      <Card
        template={grunt}
        instance={instanceOf(grunt, { indexValues: { [POWER]: 7 } })}
        definition={duel}
      />
    );
    expect(container.querySelector('.cb-pip b')).toHaveTextContent('7');
    expect(container.querySelector('.cb-pip')).toHaveAttribute('data-pos', 'bottomLeft');
  });

  it('falls back to the template default with no instance', () => {
    const { container } = render(<Card template={grunt} definition={duel} />);
    expect(container.querySelector('.cb-pip b')).toHaveTextContent('1');
  });

  it('shows a value of 0 rather than treating it as absent', () => {
    // ?? not ||, or a clamped-to-zero counter (AC: A4) silently reads as its default.
    const { container } = render(
      <Card
        template={grunt}
        instance={instanceOf(grunt, { indexValues: { [POWER]: 0 } })}
        definition={duel}
      />
    );
    expect(container.querySelector('.cb-pip b')).toHaveTextContent('0');
  });

  it('renders a true flag as an icon with no number', () => {
    const flagged = withFlag(grunt);
    const { container } = render(
      <Card
        template={flagged}
        instance={instanceOf(flagged, { indexValues: { idx_tapped: true } })}
        definition={duel}
      />
    );
    expect(container.querySelector('.cb-pip use')).toHaveAttribute('href', '#gi-cycle');
    expect(container.querySelector('.cb-pip b')).toBeNull();
  });

  it('renders nothing at all for a false flag', () => {
    const flagged = withFlag(grunt);
    const { container } = render(<Card template={flagged} definition={duel} />);
    expect(container.querySelectorAll('.cb-pip')).toHaveLength(0);
  });

  it('names each pip, since the glyph alone carries no meaning', () => {
    render(<Card template={grunt} definition={duel} />);
    expect(screen.getByRole('img', { name: 'Power' })).toBeInTheDocument();
  });
});

describe('modified values (§6.8)', () => {
  const flagged = withFlag(grunt);

  it('renders a plain pip when the effective value equals the base', () => {
    const { container } = render(
      <Card
        template={grunt}
        instance={instanceOf(grunt, { indexValues: { [POWER]: 3 } })}
        effective={{ [POWER]: 3 }}
        definition={duel}
      />
    );
    const pip = container.querySelector('.cb-pip')!;
    expect(pip.querySelector('b')).toHaveTextContent('3');
    expect(pip).not.toHaveAttribute('data-modified');
    expect(pip).not.toHaveAttribute('title');
    expect(pip.querySelector('.cb-pip__delta')).toBeNull();
  });

  it('shows the effective value, the delta IN TEXT, and the base in the title when buffed', () => {
    const { container } = render(
      <Card
        template={grunt}
        instance={instanceOf(grunt, { indexValues: { [POWER]: 1 } })}
        effective={{ [POWER]: 3 }}
        definition={duel}
      />
    );
    const pip = container.querySelector('.cb-pip')!;
    expect(pip.querySelector('b')).toHaveTextContent('3');
    // The text is the CARRIER; the green tint is redundant reinforcement (§6.9). A test that only
    // asserted data-modified would keep passing after someone deleted the <sup>.
    expect(pip.querySelector('.cb-pip__delta')).toHaveTextContent('+2');
    expect(pip).toHaveAttribute('data-modified', 'up');
    expect(pip).toHaveAttribute('title', 'base 1');
  });

  it('signs the delta when debuffed', () => {
    const { container } = render(
      <Card
        template={grunt}
        instance={instanceOf(grunt, { indexValues: { [POWER]: 4 } })}
        effective={{ [POWER]: 1 }}
        definition={duel}
      />
    );
    const pip = container.querySelector('.cb-pip')!;
    expect(pip.querySelector('b')).toHaveTextContent('1');
    expect(pip.querySelector('.cb-pip__delta')).toHaveTextContent('-3');
    expect(pip).toHaveAttribute('data-modified', 'down');
    expect(pip).toHaveAttribute('title', 'base 4');
  });

  it('renders a keyword a modifier GRANTED, which a false flag alone would not render at all', () => {
    const { container } = render(
      <Card
        template={flagged}
        instance={instanceOf(flagged, { indexValues: { idx_tapped: false } })}
        effective={{ idx_tapped: true }}
        definition={duel}
      />
    );
    const pip = container.querySelector('.cb-pip')!;
    // Dashed outline in card.css — SHAPE, so the granted keyword survives a monochrome print.
    expect(pip).toHaveAttribute('data-modified', 'granted');
    expect(pip).toHaveAttribute('title', 'base false');
    expect(screen.getByRole('img', { name: 'Tapped (granted)' })).toBeInTheDocument();
  });

  it('keeps a keyword a modifier REMOVED on the card, struck through rather than vanished', () => {
    const { container } = render(
      <Card
        template={flagged}
        instance={instanceOf(flagged, { indexValues: { idx_tapped: true } })}
        effective={{ idx_tapped: false }}
        definition={duel}
      />
    );
    // Vanishing would be indistinguishable from a card that never had the keyword.
    const pip = container.querySelector('.cb-pip')!;
    expect(pip).toHaveAttribute('data-modified', 'removed');
    expect(pip).toHaveAttribute('title', 'base true');
    expect(screen.getByRole('img', { name: 'Tapped (removed)' })).toBeInTheDocument();
  });

  it('still renders nothing for a false flag no modifier touched', () => {
    const { container } = render(
      <Card template={flagged} effective={{ idx_tapped: false }} definition={duel} />
    );
    expect(container.querySelectorAll('.cb-pip')).toHaveLength(0);
  });

  it('marks a runtime tag as granted and leaves the printed ones alone', () => {
    const { container } = render(
      <Card template={grunt} tags={[...grunt.tags, 'enchanted']} definition={duel} />
    );
    const tagline = container.querySelector('.cb-card__tagline')!;
    expect(tagline).toHaveTextContent(`${grunt.tags.join(' · ')} · enchanted`);
    expect(tagline).toHaveAttribute('title', `${grunt.tags.join(' · ')} · enchanted`);

    const granted = tagline.querySelectorAll('[data-granted]');
    expect(granted).toHaveLength(1);
    expect(granted[0]).toHaveTextContent('enchanted');
    // Dashed underline in card.css, the same shape-not-colour distinction the boolean pip makes.
    for (const tag of grunt.tags) {
      expect(within(tagline as HTMLElement).getByText(tag)).not.toHaveAttribute('data-granted');
    }
  });

  it('drops a tag a rule removed, since the tagline is the effective list', () => {
    const { container } = render(<Card template={grunt} tags={[]} definition={duel} />);
    expect(container.querySelector('.cb-card__tagline')).toBeEmptyDOMElement();
  });

  it('falls back to the template tags with no prop, which is the catalog', () => {
    const { container } = render(<Card template={grunt} definition={duel} />);
    const tagline = container.querySelector('.cb-card__tagline')!;
    expect(tagline).toHaveTextContent(grunt.tags.join(' · '));
    expect(tagline.querySelectorAll('[data-granted]')).toHaveLength(0);
  });

  it('hides the delta with the number it annotates below 64px', () => {
    // jsdom implements no container queries, so the proof is the stylesheet itself. A lone "+1"
    // with no value under it is worse than showing nothing.
    const css = readFileSync(join(process.cwd(), 'src/theme/card.css'), 'utf8');
    expect(css).toMatch(
      /@container \(max-width: 64px\)[^}]*\.cb-pip__delta[^}]*\{\s*display:\s*none/
    );
  });
});

describe('face-down', () => {
  it('renders the back INSTEAD of the body — no hidden data in the DOM', () => {
    const { container } = render(<Card template={grunt} faceDown definition={duel} />);

    expect(container.querySelector('.cb-card__back')).toBeInTheDocument();
    expect(container.querySelector('.cb-card__body')).toBeNull();
    expect(container.querySelector('.cb-card__pips')).toBeNull();
    // The real hazard is Ctrl-F and devtools, not the rendered pixels: a hot-seat tool whose whole
    // point is that seat 2 cannot see seat 1's hand.
    expect(container.innerHTML).not.toContain(grunt.marquee);
    expect(container.innerHTML).not.toContain(grunt.faceIcon);
  });

  it('announces itself without naming the card', () => {
    render(<Card template={grunt} faceDown definition={duel} />);
    expect(screen.getByLabelText('Face-down card')).toBeInTheDocument();
    expect(screen.queryByText(grunt.marquee)).not.toBeInTheDocument();
  });

  it("honours the instance's own flag when the caller passes nothing", () => {
    // ZoneView resolves visibility, but a caller that forgets must not expose the card.
    const { container } = render(
      <Card template={grunt} instance={instanceOf(grunt, { faceDown: true })} definition={duel} />
    );
    expect(container.querySelector('.cb-card__back')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(grunt.marquee);
  });

  it('lets an explicit reveal win over the instance flag', () => {
    const { container } = render(
      <Card
        template={grunt}
        instance={instanceOf(grunt, { faceDown: true })}
        faceDown={false}
        definition={duel}
      />
    );
    expect(container.querySelector('.cb-card__body')).toBeInTheDocument();
  });
});

describe('rotated', () => {
  it('is an attribute on the root, so the slot keeps the unrotated footprint', () => {
    const { container } = render(
      <Card template={grunt} instance={instanceOf(grunt, { rotated: true })} definition={duel} />
    );
    expect(container.querySelector('.cb-card')).toHaveAttribute('data-rotated', 'true');
    // The 90deg lives on .cb-card__tilt in card.css — never on the dnd-kit node (§6.9).
    expect(container.querySelector('.cb-card__tilt')).toBeInTheDocument();
  });

  it('defaults to false with no instance', () => {
    const { container } = render(<Card template={grunt} definition={duel} />);
    expect(container.querySelector('.cb-card')).toHaveAttribute('data-rotated', 'false');
  });
});

describe('interaction', () => {
  it('is inert static content when no handler is given', () => {
    const { container } = render(<Card template={grunt} definition={duel} />);
    const card = container.querySelector('.cb-card')!;
    expect(card).not.toHaveAttribute('role');
    expect(card).not.toHaveAttribute('tabindex');
  });

  it('is reachable by keyboard when it is clickable', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Card template={grunt} definition={duel} onClick={onClick} />);

    const card = screen.getByRole('button');
    await user.click(card);
    card.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('ignores other keys', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Card template={grunt} definition={duel} onClick={onClick} />);

    screen.getByRole('button').focus();
    await user.keyboard('{ArrowRight}');
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('catalog and in-play render identically (AC: L2)', () => {
  it('produces byte-identical markup from both contexts', () => {
    const instance = instanceOf(grunt, { indexValues: { [POWER]: 3 } });
    const props = { template: grunt, instance, definition: duel };

    // Same component, same props, two different container contexts. The only thing that differs in
    // the real app is --cb-card-w and the class on the CONTAINER — never the card's own markup.
    const catalog = render(
      <div className="cb-catalog-grid" style={{ '--cb-card-w': '96px' } as React.CSSProperties}>
        <Card {...props} />
      </div>
    );
    const catalogHtml = catalog.container.querySelector('.cb-card')!.outerHTML;
    catalog.unmount();

    const play = render(
      <div className="cb-zone" style={{ '--cb-card-w': '116px' } as React.CSSProperties}>
        <Card {...props} />
      </div>
    );
    const playHtml = play.container.querySelector('.cb-card')!.outerHTML;

    // No normalisation at all — §9.1 allows normalising a data-context attribute, but nothing sets
    // one, so the stronger assertion is the honest one.
    expect(playHtml).toBe(catalogHtml);
  });

  it('takes no size, variant or mode prop', () => {
    // The structural half of L2. A `size` prop is how "they render identically" quietly stops being
    // true, and it would pass every rendering test above.
    const source = readFileSync(join(process.cwd(), 'src/components/card/Card.tsx'), 'utf8');
    const propsBlock = source.slice(
      source.indexOf('export interface CardProps'),
      source.indexOf('export function Card')
    );
    for (const banned of ['size', 'variant', 'mode']) {
      expect(propsBlock).not.toMatch(new RegExp(`^\\s*${banned}\\??:`, 'm'));
    }
  });

  it('scales from the container, and the breakpoints are the ones §6.3 specifies', () => {
    // jsdom implements no container queries, so the proof is the stylesheet itself.
    const css = readFileSync(join(process.cwd(), 'src/theme/card.css'), 'utf8');
    expect(css).toMatch(/\.cb-card\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/@container \(max-width: 118px\)[^}]*\.cb-card__rules\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@container \(max-width: 88px\)[^}]*\.cb-card__tagline\s*\{\s*display:\s*none/);
    expect(css).toMatch(/@container \(max-width: 64px\)[^}]*\.cb-pip b\s*\{\s*display:\s*none/);
  });
});

describe('the whole catalog renders', () => {
  it('renders every fixture template without throwing', () => {
    // Cheap smoke over real authored data: catches a template shape the component never saw.
    for (const template of duel.templates) {
      const { container, unmount } = render(<Card template={template} definition={duel} />);
      expect(container.querySelector('.cb-card__marquee')).toHaveTextContent(template.marquee);
      unmount();
    }
    expect(duel.templates.map((t) => t.id)).toContain(CANTRIP);
  });
});
