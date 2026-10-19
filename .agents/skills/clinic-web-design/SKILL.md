---
name: clinic-web-design
description: Design, review, and improve the public website for Consultorio Odontológico Franco Vinzón. Use for landing pages, visual design, responsive layout, navigation, conversion, accessibility, and frontend polish. Preserve the existing plain HTML/CSS/JS and the clinic's visual identity.
---

# Clinic website design and UX

Use this skill when changing the public clinic website, not as a license to redesign unrelated patient or admin tools.

## Project constraints

- Read `CLAUDE.md`, `architecture.md`, `decisions.md`, and `tasks.md` before substantial changes.
- This is static HTML/CSS/JS plus Vercel functions. Do not introduce a framework or dependencies for a visual-only change.
- Keep the brand's navy, warm white, and gold palette and its existing typography unless a redesign is explicitly requested.
- The site supports real patients. Keep contact, appointment, hours, and emergency paths visible and accurate.
- Never expose patient information or fabricate testimonials, credentials, results, availability, or clinical claims.

## Workflow

1. Identify the user and business goal for the page, then inspect the current markup, styles, related pages, and viewport behavior.
2. Fix structure and task flow first: clear page hierarchy, obvious next action, semantic HTML, keyboard operation, and responsive behavior.
3. Keep visual choices consistent with the established brand. Use whitespace and type hierarchy before adding decoration. Motion must clarify state or affordance, remain restrained, and respect `prefers-reduced-motion`.
4. Make controls discoverable and operable by touch and keyboard. Provide visible focus, descriptive labels, sufficient contrast, and touch targets around 44 CSS pixels when practical.
5. Preserve server/API behavior and content unless the request requires changing it. Avoid new dependencies and avoid unnecessary JavaScript.
6. Follow the project's branch → Vercel preview → review → main workflow. Do not deploy unreviewed changes.

## Review checklist

- On narrow screens, users can reach every important section and the primary contact/booking action remains clear.
- Navigation is semantic, has an accessible name, works without a pointer, and closes after selecting a destination when implemented as a disclosure menu.
- Heading levels, landmarks, link names, image alternatives, and form labels make sense without visual styling.
- Keyboard focus is always visible. Hover is never the only indication of interactivity.
- Reduced-motion preferences are honored; no essential content depends on animation.
- Content is accurate, plain-language, locally relevant, and respectful of patients.
- The design remains lightweight: no unnecessary large assets, third-party widgets, libraries, or layout shifts.

## Sources

- W3C WCAG overview: https://www.w3.org/WAI/standards-guidelines/wcag/
- W3C WCAG 2.2 changes: https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- web.dev Core Web Vitals: https://web.dev/articles/vitals
