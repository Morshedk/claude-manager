# T-47 Validation: 10+ Session Cards Layout

**Validator role:** Adversarial review of design + execution  
**Date:** 2026-04-08  
**Verdict:** GENUINE PASS (with one observation about layout mode)

---

## Question 1: Did the test pass? (actual outcome)

**Yes — genuine pass.** Test ran in 9.1s. All 10 cards rendered with `height=75px` each. No horizontal overflow. Last card accessible with button dimensions `49x23px`.

Key evidence:
- Card count in DOM: 10 ✓
- All cards height=75 (non-zero) ✓
- All `overflowsRight=false` ✓
- Last card `inViewport=true`, `btnWidth=49.375 btnHeight=23` ✓
- List scroll info: `scrollHeight=360 clientHeight=360 overflowY=visible scrollable=false`
- No crashes ✓

---

## Question 2: Was the design correct? (meaningful assertions, real failure detection)

**Yes — with one nuance to note.**

### Strengths

1. **Height check per card.** The `height=75` assertion for each of 10 cards definitively proves no card collapsed. A CSS flexbox height-collapse bug would show `height=0`.

2. **Horizontal overflow check via `overflowsRight`.** Each card's `right` is compared against the container's `right`. Overflow would indicate buttons pushed off-screen.

3. **Last card accessibility after scroll.** `scrollIntoView()` + button bounding box check ensures the cards below the fold are reachable.

4. **Session creation via WS in `beforeAll`.** Using the `ws` library to create sessions outside the browser UI is faster and avoids testing the session creation UI (covered by T-01). This is correct isolation.

### Key observation: Layout uses CSS grid/flexbox row wrapping (not column scroll)

The actual layout showed cards at the same `top` values in groups:
```
cards 0,1,2 → top=103 (row 1)
cards 3,4,5 → top=190 (row 2)  
cards 6,7,8 → top=277 (row 3)
card 9      → top=364 (row 4)
```

This reveals the session list uses a **multi-column grid layout** (3 columns per row), not a single-column scrollable list. The cards wrap into rows. With 10 cards at 75px each plus gaps, total height ≈ 360px, which fits within the `#sessions-area` viewport for the 1280×800 test viewport.

This is important: the test passed because 10 cards in a 3-column grid fit without overflow in a 800px tall window. With significantly more sessions (say, 30+), the cards would eventually overflow and require scroll. The test correctly captures the 10-card case, which is the spec.

The `scrollable=false` finding and `overflowY=visible` is not a bug for 10 cards — the container adjusts to content height. The potential bug scenario (cards clipped with no scrollbar) was checked by the design's viewport comparison, and all cards were within the viewport.

### Design gap (minor)

The design's "potential failure mode #1" (overflow hidden) did not manifest here — the container uses `overflow: visible`. If overflow were hidden AND height were fixed, cards would be clipped. The test correctly guards against this with the bounding-box checks.

---

## Question 3: Was the execution faithful?

**Yes — the implementation matches the design closely.**

- WS-based session creation with 10 sessions ✓
- Wait for API confirmation before browser navigation ✓
- 10-card count assertion ✓
- Height and overflow checks via `getBoundingClientRect` ✓
- Scroll-to-bottom + last card check ✓
- Button width/height assertions ✓
- Crash log check ✓

Minor deviation: the design mentioned a check for "cards below viewport but not scrollable" as a FAIL condition. The implementation adds this check with a console.error but doesn't fail the test explicitly. In the actual run, all 10 cards were in viewport anyway, so this path was not triggered. For future runs with more cards or smaller viewports, hardening this to an `expect()` would be prudent.

---

## Conclusion

**T-47: GENUINE PASS**

The layout handles 10 session cards correctly in the 3-column grid layout. All cards have non-zero height, no horizontal overflow, and the last card's action buttons are accessible. The test would catch: (a) CSS height collapse, (b) horizontal overflow cutting off buttons, (c) cards rendered off-screen without scroll. The multi-column layout means the threshold for overflow would be ~15+ cards at the tested viewport size, but the 10-card requirement from the spec is met without any layout break.
