# Telegram Social Media Downloader Web App

Web interface jo Telegram bot (@Ebenozdownbot) ke saath kaam karta hai aur social media videos download karta hai.

## Features

- 🌐 Simple web interface
- 📥 Social media links se videos download
- 🤖 Telegram bot integration
- 📹 Sirf videos download (animations nahi)
- ⚡ Real-time download status
- 🎨 Beautiful loading animations

## Setup Instructions (Local Development)

### 1. Telegram API Credentials Le Lo

1. https://my.telegram.org pe jao
2. Login karo apne phone number se
3. "API Development Tools" pe click karo
4. App ka naam dalo aur create karo
5. `API_ID` aur `API_HASH` copy kar lo

### 2. Project Setup

```bash
# Dependencies install karo
npm install

# .env file banao
cp .env.example .env
```

### 3. Environment Variables (.env file mein)

```env
TELEGRAM_API_ID=your_api_id_here
TELEGRAM_API_HASH=your_api_hash_here
TELEGRAM_SESSION=
BOT_USERNAME=@Ebenozdownbot
PORT=3000
```

### 4. First Run (Session String Lene Ke Liye)

```bash
npm start
```

- Pehli baar run karne pe phone number manga
- OTP enter karo
- Console mein session string print hoga
- Us session string ko copy karke `.env` file mein `TELEGRAM_SESSION` mein paste karo

### 5. App Chalao

```bash
npm start
```

App `http://localhost:3000` pe chal jayega

## Render Pe Deploy Kaise Karein

### Step 1: GitHub Pe Code Push Karo

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

### Step 2: Render Pe Deploy

1. **Render.com** pe jao aur login karo
2. **New +** button pe click karo
3. **Web Service** select karo
4. Apna GitHub repo connect karo
5. Settings fill karo:
   - **Name**: koi bhi naam (e.g., telegram-downloader)
   - **Environment**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

### Step 3: Environment Variables Set Karo

Render dashboard mein **Environment** section pe jao aur ye variables add karo:

```
TELEGRAM_API_ID = your_api_id
TELEGRAM_API_HASH = your_api_hash
TELEGRAM_SESSION = your_session_string
BOT_USERNAME = @Ebenozdownbot
PORT = 3000
```

**IMPORTANT**: `TELEGRAM_SESSION` ko pehle local pe generate karna padega (Step 4 dekho upar)

### Step 4: Deploy Karo

- **Create Web Service** button pe click karo
- Render automatically deploy kar dega
- Deploy complete hone ke baad app ka URL milega

## Kaise Use Karein

1. Web interface kholo
2. Social media link paste karo (Instagram, TikTok, Twitter, etc.)
3. Download button daba do
4. Loading animation dekho
5. Video ready ho jayegi aur page pe play hogi
6. Download button se video save kar sakte ho

## Project Structure

```
downloder/
├── server.js           # Main server file
├── package.json        # Dependencies
├── .env               # Environment variables (create karni hogi)
├── .env.example       # Example env file
├── README.md          # Ye file
└── public/
    ├── index.html     # Web interface
    └── downloads/     # Downloaded videos (auto-generated)
```

## Important Notes

### Video Only Logic

Code mein special logic hai jo sirf videos handle karti hai:

```javascript
const isVideo = attributes.some(attr =>
    attr.className === 'DocumentAttributeVideo'
);
```

Ye check animations ko ignore kar dega aur sirf proper videos download karega.

### Session String

- Session string ek baar generate hone ke baad reuse ho sakti hai
- Session string se har baar OTP nahi mangta
- Session string ko safe rakho, ye tumhare Telegram account ka access hai

### Free Tier Limitations (Render)

- 750 hours/month free (24/7 chalane ke liye kaafi hai)
- Service 15 minutes inactivity ke baad sleep mode mein ja sakti hai
- First request pe wake up hoga (thoda slow)
- Paid plan lene se always-on rahega

## Troubleshooting

### "Telegram Disconnected" dikha raha hai

- Environment variables check karo
- Session string sahi hai ya nahi check karo
- Logs dekho Render dashboard mein

### Videos download nahi ho rahi

- Bot username (`@Ebenozdownbot`) sahi hai?
- Bot ko pehle manually Telegram pe start kiya hai?
- Link valid hai?

### Local pe chal raha hai but Render pe nahi

- Environment variables Render pe set hain?
- Build logs check karo for errors
- Session string properly paste kiya?

## Tech Stack

- **Backend**: Node.js, Express
- **Telegram**: telegram (GramJS)
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Deployment**: Render

## Support

Koi issue ho to:
1. Logs check karo (Render dashboard mein)
2. Environment variables verify karo
3. Session string regenerate kar ke try karo

---

Made with ❤️ for easy social media downloads!
