# Speakist pricing strategy

Status: **launching with consumption-only**, dual-tier optionality reserved for v2.

This document records *why* we priced the way we did so future decisions don't re-litigate ground we've already covered. Numeric models live in [`pricing-calculator.html`](pricing-calculator.html) — the doc here is the rationale.

## Positioning

We are the **lower-cost, simpler, premium option** vs. flat-rate dictation tools (Wispr Flow $144/yr, Aqua $96/yr, MacWhisper, Superwhisper). We accept fewer features in exchange — feature breadth lives at our competitors. We compete on **price, simplicity, and just-works reliability**.

Marketing wedge: **"Half the price of Wispr Flow. No subscription. Pay for what you use."**

We do not compete on being the absolute cheapest per-word rate — that signals commodity and attracts heavy/loud users we can't profitably serve. We compete on **no commitment** and **clearly-cheaper-than-Wispr-at-typical-use**.

## Pricing model

**Consumption-based prepaid credits.** No subscription. Top-ups are minimum $5.

Internally we track balance as integer millicents (1/1000 of a cent), but **users see remaining balance in words**, not dollars. Words are the utility unit; dollars are the accounting unit. Admin/billing pages show dollars; everywhere else shows words.

This separation gives us pricing flexibility (rate changes, premium tiers later) without exposing financial salience to the user on every dictation.

### Headline rate

**$0.20 per 1,000 words** (= 20 millicents/word internally).

Anchor: roughly **half the price of Wispr Flow Pro at typical use** (30K words/month). Below Aqua Voice Pro's effective rate at typical use ($0.27/1K). Well above Rev AI's commodity floor ($1.67/1K).

| Use band | Wispr ($/mo) | Speakist at $0.20/1K |
|---|---|---|
| Casual (10K wd/mo) | $12 | $2 — 6× cheaper |
| **Typical (30K wd/mo)** | $12 | **$6 — 2× cheaper** ← anchor |
| Power (40K wd/mo) | $12 | $8 — 33% cheaper |
| Heavy (60K wd/mo) | $12 | $12 — tied (heavy users break-even) |

The "tie at heavy use" is intentional: heavy users are unprofitable for us at consumption pricing and unprofitable for Wispr at flat-rate. Letting them stay on Wispr is the right outcome.

### Top-up tiers (volume discount ladder)

| Pay | Get (credit) | Words at base rate | Bonus | Effective $/1K |
|---|---|---|---|---|
| $5 | $5.00 | 25,000 | 0% | $0.200 |
| $10 | $10.50 | 52,500 | 5% | $0.190 |
| $25 | $30.00 | 150,000 | 20% | $0.167 |
| $50 | $65.00 | 325,000 | 30% | $0.154 |
| $100 | $150.00 | 750,000 | 50% | $0.133 |

The bonus is *additional ledger credit* on top of the dollar amount paid. A $50 payment gets $65 of credit; the user paid $50 to Stripe but their balance shows the $65 worth.

**Why these tiers:**
- $5 floor: keeps Stripe percent fee tolerable (~9%); below this the fixed $0.30 fee dominates.
- 0% bonus on $5: smallest SKU is the impulse/trial size — we don't want to subsidize commitment-phobes.
- Strong ramp at $25 (+20%) and beyond: rewards meaningful commitment, makes the ladder visible.
- Top tier (+50%) is the loud headline — "Save 50%" works as marketing copy.

**Why bonus credit and not "more words at a different rate":**
- Internal accounting stays in millicents (no per-purchase rate tracking)
- Stripe receipt matches what the user paid (no awkward "you paid $50 for a $65 product")
- Future rate changes don't retroactively shift past purchases — credit is denominated in millicents, not words

### Free trial

**3,000 words on signup, one-time.**

- ~10–30 dictations — enough to evaluate quality
- ~$0.60 of face value at the headline rate, ~$0.016 of actual COGS (transcription + polish)
- One-time only: no monthly recurring grant. Avoids Wispr's mistake of letting free users live on the free tier indefinitely.
- If a user wants ongoing free use, they buy a $5 pack and ration it — that's the path we want them on.

### Auto top-up + monthly cap

Auto top-up addresses the unbounded-billing anxiety that pure consumption pricing creates. Users opt in:

- Threshold: balance below which auto-charge fires
- Amount: how much to charge (no bonus — auto-topups credit at face value)
- **Maximum monthly spend (cap)**: hard limit on auto-topup spend per calendar month

If a fresh auto-topup charge would push the rolling-month auto-topup spend above the cap, we skip the charge and let the balance go negative. The user gets a notification (TODO: Resend) and tops up manually.

The cap is the unlock for behavioral economics here: bounded downside removes the "what if I get a $200 surprise bill" friction. Even users who never come close to their cap report higher willingness-to-use when one exists.

## Behavioral economics behind these decisions

1. **Flat-rate bias is real** but doesn't apply equally everywhere. Our target market (people who already think Wispr is too expensive) has *self-selected against* flat-rate bias. They're price-sensitive enough to do the math.
2. **Anchoring on words, not dollars** mirrors phone-plan minutes, Audible credits, and casino chips — virtual currencies that mute the per-action transactional friction. Showing "$3.20 left" makes every dictation feel like spending. Showing "12,500 words left" makes it feel like using a feature.
3. **The taxi-meter problem** is the failure mode we're avoiding. Bounded caps + word-denominated balances + bonus tiers all push against "I'd better be careful, this is costing me."
4. **Volume discounts work because of mental accounting**: the user perceives a $50 pack at +30% as "saving $15," not "paying $50 for some words." The bonus headline (`+30%`, `Save 50%`) does meaningful psychological work even when the per-1K rate gap is modest.

## Future considerations

These are intentional non-goals for v1, parked here for the next round.

### Add a flat-rate "Plus" tier — *only if signal demands it*

Triggering signal: ≥30% of MAU topping up 2+ times/month for 3+ months. That subset would be better served by — and more loyal to — a subscription.

Proposed shape:
- **Speakist Plus: $4/mo or $40/yr → 25,000 words/mo, rollover up to 50K**
- Positioning: "If you top up every month anyway, Plus saves you 20% and never expires within the month."
- Still cheaper than every flat-rate competitor: 67% under Wispr, 50% under Aqua at the same volume band.
- Rollover prevents the "wasting money this month" cancellation pathology.

If we never see that signal, Plus doesn't ship. Don't add complexity to chase a hypothesis.

### Premium models / tiers

When we add premium polish (e.g. Llama 70B) or a more accurate STT (Whisper non-turbo, Deepgram Nova-3, GPT-4o transcription), the cleanest model is **debits more millicents per dictation, not more dollars per word**.

Internal math: same `pricePerWordMillicents` rate for display conversion; `provider_pricing` rows already capture per-(provider, model) variable costs that flow into the debit.

User experience: "You used 1.5× words on this premium transcription" stays in the words mental model. Avoid splitting the user-facing balance into multiple currencies.

### Referral grants

At ~$0.016 COGS for a 3,000-word grant, referrals are essentially free. Designs to consider:
- Both sides get 5,000 words on a successful referral (~$0.027 COGS each = $0.054 per acquired user)
- Tier-bonus for active referrers (5+ referrals → 10% off all top-ups for 3 months)

Decision deferred until launch traction is known — referral programs are easy to launch, hard to undo, and best when the activation flow is already clean.

### Win-back / re-engagement grants

Cheap insurance against churn. A user who hasn't dictated in 30 days gets a "We've added 3,000 words to your balance — come back" email. ~$0.016 COGS per email. Run as a manual experiment first; automate if measurable.

### Org / team pricing

Currently every paying entity is an "org" (single user = single-member org). Future:
- Multi-seat top-ups with shared balance (already supported by the schema — `org_members` exists)
- Volume pricing for team-level commitments ($500 → 1.7M words, etc.)
- BYO Groq/Deepgram keys for orgs that prefer to bill upstream directly (already implemented; encrypted overrides per org)

### Annual prepay / "Lifetime" credits

Watch this one: Superwhisper raised their Lifetime tier from $250 → $849, suggesting it works. We could test a $200 / 1M words pack (effective $0.20/1K, deepest discount, locks user in).

But: deep prepays are also customer-acquisition steroids that mask churn. Don't add until consumption metrics are healthy and we're confident in retention.

### Anti-abuse

At our COGS structure, abuse risk on the free tier is low ($0.016 per fake account). But:
- Rate-limit signups per IP / device fingerprint
- Require email verification before granting (already does)
- Watch for anomalous patterns: 100+ accounts from one IP, accounts that hit signup → max-out free → never return

Defer building these until evidence of abuse appears. Don't preempt phantom problems.

## What we're explicitly *not* doing

- **No per-seat per-month pricing.** That's our differentiator's mirror image. Don't drift toward it.
- **No "unlimited" tier.** Heavy users adversely select onto unlimited and erode margins. They're our competition's problem, not ours.
- **No mid-billing-cycle prorations.** Top-ups are top-ups. Refunds happen via Stripe in dollars.
- **No coupons / promo codes** at launch. Use referral grants as the discount lever instead.

## Cost basis (sanity check)

At every tier in the SKU ladder, gross margin (after Stripe + Groq COGS + Cloudflare variable) stays above 85%. The biggest tier ($100 / 500K words) has the *lowest* fee drag because Stripe's $0.30 fixed amortizes over a larger charge. Bigger packs are more profitable for us, not less.

See [`pricing-calculator.html`](pricing-calculator.html) for the live model. Adjust inputs there before changing prices in code.
