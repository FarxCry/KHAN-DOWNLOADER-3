FROM node:20-slim

# python3 is needed for the yt-dlp script; ffmpeg for audio/MP3 conversion
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp as a Python script: works on ANY CPU (x86 or ARM)
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && yt-dlp --version

WORKDIR /app
COPY package.json server.js index.html ./

ENV NODE_ENV=production
EXPOSE 8765
CMD ["node", "server.js"]
