# DeepMeta Never Sleep

A browser extension that prevents your computer from sleeping during active file uploads on [DeepMeta](https://deepmeta.creativ.zone/).

## Features

- Automatically detects when DeepMeta tabs are open
- Monitors for active file upload sessions
- Keeps your computer awake during uploads (screen can turn off)
- Supports multiple DeepMeta tabs simultaneously
- Works across Firefox, Chrome, and Edge

## How It Works

The extension:
1. Monitors all DeepMeta tabs for file upload activity
2. Detects uploads through multiple methods (XHR, Fetch API, DOM monitoring)
3. Uses the browser's Power Management API to prevent system sleep
4. Automatically releases the keep-awake lock when uploads complete
5. Allows your screen to turn off while keeping the system active

## Installation

### Chrome / Edge

1. Clone or download this repository
2. Open Chrome/Edge and navigate to `chrome://extensions/` (or `edge://extensions/`)
3. Enable "Developer mode" (toggle in top-right corner)
4. Click "Load unpacked"
5. Select the `DeepMetaNeverSleep` folder

### Firefox

1. Clone or download this repository
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Navigate to the `DeepMetaNeverSleep` folder and select `manifest.json`

**Note:** For permanent installation in Firefox, the extension needs to be signed. For development/personal use, the temporary installation method works perfectly.

### Firefox Permanent Installation (Optional)

To install permanently in Firefox:
1. Package the extension: `cd DeepMetaNeverSleep && zip -r ../deepmeta-never-sleep.zip *`
2. Submit to [Firefox Add-ons](https://addons.mozilla.org/developers/) for signing
3. Or use [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) for local development

## Usage

Once installed, the extension works automatically:

1. Open one or more DeepMeta tabs (`https://deepmeta.creativ.zone/`)
2. Start uploading files
3. The extension will detect the upload and prevent system sleep
4. When uploads complete, the keep-awake lock is automatically released

### Checking Status

To verify the extension is working:

1. Open browser console (F12)
2. Look for messages prefixed with `[DeepMeta Never Sleep]`
3. You'll see notifications when:
   - The extension loads
   - Uploads start/stop
   - Keep-awake is enabled/disabled

Example console output:
```
[DeepMeta Never Sleep] Content script loaded
[DeepMeta Never Sleep] XHR upload detected: https://deepmeta.creativ.zone/api/upload
[DeepMeta Never Sleep] Upload started in tab 123
[DeepMeta Never Sleep] Keep awake enabled (1 active uploads)
```

## Development

### Project Structure

```
DeepMetaNeverSleep/
├── manifest.json          # Extension configuration
├── background.js          # Background service worker (power management)
├── content.js            # Content script (upload detection)
├── icons/                # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   ├── icon128.png
│   ├── icon.svg          # Source SVG
│   ├── generate_icons.py # Python icon generator
│   └── generate-icons.html # Browser-based icon generator
└── README.md             # This file
```

### How Upload Detection Works

The extension uses multiple detection strategies to ensure reliability:

1. **XHR Monitoring**: Intercepts XMLHttpRequest calls with FormData/File/Blob bodies
2. **Fetch API Monitoring**: Intercepts fetch() calls with file upload payloads
3. **DOM Observation**: Watches for upload progress UI elements as a backup
4. **Periodic Checks**: Scans for visible upload indicators every 5 seconds

### Regenerating Icons

If you want to customize the icons:

**Option 1 - Python:**
```bash
cd icons
python3 generate_icons.py
```

**Option 2 - Browser:**
```bash
# Open icons/generate-icons.html in your browser
# Click the download buttons for each icon size
```

**Option 3 - Manual:**
Edit `icons/icon.svg` and convert to PNG using your preferred tool.

## Permissions Explained

The extension requires these permissions:

- `tabs`: To detect when DeepMeta tabs are open
- `power`: To prevent system sleep during uploads
- `scripting`: To inject upload detection into existing tabs
- `https://deepmeta.creativ.zone/*`: To access and monitor DeepMeta pages

## Troubleshooting

### Extension not detecting uploads

1. Check browser console for `[DeepMeta Never Sleep]` messages
2. Verify the extension is enabled
3. Reload the DeepMeta page
4. Check that uploads are actually happening (progress bars visible)

### System still sleeping

1. Verify the extension shows "Keep awake enabled" in console
2. Check browser permissions allow power management
3. Some operating systems may override browser power management (check OS settings)
4. Try the extension in a different browser

### Firefox "Temporary Add-on"

Firefox temporary add-ons are removed when Firefox closes. For permanent installation:
- Use web-ext for development: `web-ext run`
- Or submit to AMO for signing

## Privacy

This extension:
- Only monitors `https://deepmeta.creativ.zone/*` pages
- Does not collect or transmit any data
- Does not access file contents
- Only detects that uploads are happening (not what is being uploaded)
- Runs entirely locally in your browser

## License

MIT License - Feel free to modify and distribute

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test in both Firefox and Chrome
5. Submit a pull request

## Support

For issues or questions:
- Check browser console for error messages
- Verify you're using DeepMeta at `https://deepmeta.creativ.zone/`
- Open an issue on GitHub with browser version and console logs
