# Discogs Preview for YouTube

Chrome extension to quickly view, filter, and link to Discogs marketplace data while digging for vinyl on YouTube. Automatically finds matching vinyl releases and shows pricing — lowest, median, VG+/NM estimates — right below the video.

## Features

- Auto-detects the YouTube video title and searches Discogs for matching vinyl releases
- Shows lowest price, median, VG+ and NM estimates with direct links to listings
- US-only toggle to filter by seller location
- Inline panel on the YouTube page + toolbar popup

## Setup

### 1. Install the extension

Clone the repo or download & unzip the ZIP from the green **Code** button above.

```bash
git clone https://github.com/Eric-A99/Discogs-Preview-for-YouTube.git
```

Then load it in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the extension folder

### 2. Add your Discogs token

You need a **Discogs Personal Access Token** — you'll be prompted the first time you use the extension.

1. Go to [discogs.com/settings/developers](https://www.discogs.com/settings/developers)
2. Click **Generate new token** and copy it
3. Paste it into the extension's settings (click the extension icon → **Settings**)

Head to YouTube, play a track, and pricing appears automatically.
