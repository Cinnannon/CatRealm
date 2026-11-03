# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [v1.9.4] - 2026-11-03

### Added
- **Dockless Mobile Architecture & Navigation (`TopHubBar` + Unified Left Rail)**:
  - Completely replaced the legacy bottom navigation dock with a modern, streamlined top header (`TopHubBar`) and unified Discord-style navigation drawer.
  - Added `DrawerLeftRail` and `DrawerHubFooter` inside `ServerDrawer` and `ChannelsSheet`, providing immediate access to server switching, direct messages, settings, profile, and active voice status.
  - Optimized tablet and large-screen layouts to maintain a clean persistent split-pane view without redundant mobile docks.
- **Custom Desktop Themes Engine Parity**:
  - Ported the desktop CSS theme parser into the React Native client runtime, allowing custom themes and accent palettes to apply consistently across mobile components.
  - Added a quick theme selector modal and settings integration with instant theme preview.
- **Interactive Gesture Navigation & Ergonomics**:
  - Added interactive edge swipe gestures to smoothly reveal and follow finger dragging when opening the server navigation drawer.
  - Added smooth swipe-left gesture to close the sidebar with touch tracking and reliable backdrop dismiss.
  - Added swipe-to-reply gesture on messages: swiping a message row horizontally reveals an animated reply badge and loads the message into the composer.
  - Added conflict resolution between drawer gestures and swipe-to-reply: swipe-to-close takes priority while a drawer is visible, and edge drawer swiping is automatically disabled on tablet screens.
- **Desktop-Parity Forum Channels (`ForumChannelView`)**:
  - Implemented dedicated forum channel interface replacing flat message lists for `forum` channel types.
  - Added thread post preview cards displaying author avatars, creation timestamps, preview snippets, image thumbnails, and comment counts.
  - Added "New Post" modal composer allowing users to create forum threads with a title, initial body, and media attachments.
- **Emoji & Custom Emote Shortcode Autocomplete**:
  - Added desktop-parity `:shortcode` autocomplete popup inside `MobileComposer`.
  - Supports fuzzy matching for standard Unicode emojis and custom server/global emotes with keyboard and touch selection.
- **Cat Reactions Viewer Modal (`MessageReactionsSheet`)**:
  - Added detailed reactions inspector accessible via message long-press context menu ("View Cat Reactions") or long-pressing any reaction badge on a message.
  - Features horizontal reaction filter tabs ("All" aggregate counter plus individual emoji chips).
  - Displays user cards with avatar, display name, username `@handle`, custom role gradients/colors, and reaction indicators.
- **GIF Favorites**:
  - Added favoriting support with star icon buttons in the GIF picker modal and persistent `AsyncStorage` cache.

### Fixed
- **Video Player Overlay Layout**:
  - Isolated `CatRealmVideoControls` into a dedicated video surface container, preventing video metadata (`title | author`) from blocking the bottom scrubber slider and playback controls.
- **Media Image Disappearing Bug**:
  - Fixed a race condition where chat images disappeared during scrolling if the background disk cache resolved while the component was re-rendering. Added a recycling key lock with graceful fallbacks.
- **Cross-Platform Compatibility**:
  - Fixed crashes on Expo Web by guarding `expo-battery` power state hooks and providing a resilient `TextInput` fallback in `MobileComposer`.
- **Automated Test Coverage**:
  - Added and updated comprehensive unit test suites covering navigation, server drawers, image placeholders, GIF favorites, and internationalization across all 37 test suites (271 passing tests).

---

## [v1.9.3] - 2026-11-01
- Desktop client audio/video capture updates and LiveKit upgrades.

## [v1.9.2] - 2026-10-31
- Mobile and desktop security updates and bug fixes.
