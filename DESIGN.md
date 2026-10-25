# Heracles interface

## Theme
A light training journal for daily phone use. Activities, current body state and the next action carry the page.

## Palette
Canvas #f6f7f4, white paper, ink #1c2922, secondary text #58665d, forest #245d42. Amber, blue and plum distinguish metrics without implying a diagnosis.

## Typography
SF Pro and PingFang on iPhone, system fallbacks elsewhere. Body 16px, secondary labels at least 14px. Use weight and spacing before adding another text tier.

## Components
44px controls. Plain activity rows with real route thumbnails. Compact metric tiles with dates and trends. Native dialogs for focused editing and course detail.

## Layout
One header and one bottom navigation. The app root stays in normal flow. Status-bar space belongs to the OS in default iOS display mode; safe-area insets are owned once per edge. Each tab has one independently scrolling content region.

## Depth
White surfaces on a light neutral canvas. A boundary or a modest shadow only when it separates a control surface. No nested decorative cards.

## Do and do not
Put the answer, session and actual measurements first. Fold supporting detail. Preserve stale and missing labels. Avoid model names, internal identifiers, tiny provenance paragraphs and repeated instructions.

## Responsive
Support 320px, standard iPhone widths and desktop. At narrow widths keep two metric columns and seven date targets. Correct root scroll on keyboard dismissal; never use global body scrolling for tab content.

## Future changes
Extend existing tokens and component styles in plain CSS. Verify actual rendered tabs and focused sheets. Desktop WebKit emulation is not physical iPhone verification.
