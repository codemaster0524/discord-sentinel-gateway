const { Client, GatewayIntentBits } = require('discord.js');

// ===== 설정 =====
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLOUDFLARE_WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || 'https://sentinel-bot.eunsung-lee-460.workers.dev';
const CONTEXT_WINDOW_MINUTES = 10; // 문맥 유지 시간 (10분)
const CHECK_INTERVAL_SECONDS = 60; // 체크 주기 (60초)

// ===== 메시지 버퍼 (채널별로 관리) =====
const messageBuffer = new Map(); // channelId -> messages[]

// ===== Discord 클라이언트 생성 =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ===== 봇 준비 =====
client.once('ready', () => {
  console.log(`✅ 봇이 로그인되었습니다: ${client.user.tag}`);
  console.log(`📊 ${client.guilds.cache.size}개 서버에 접속 중`);
  
  // 1분마다 메시지를 Cloudflare Worker로 전송
  setInterval(async () => {
    await checkAndSendMessages();
  }, CHECK_INTERVAL_SECONDS * 1000);
  
  // 오래된 메시지 정리 (1분마다)
  setInterval(() => {
    cleanOldMessages();
  }, 60000);
});

// ===== 메시지 수신 =====
client.on('messageCreate', async (message) => {
  // 봇 메시지 무시
  if (message.author.bot) return;
  
  // DM 무시
  if (!message.guild) return;
  
  const channelId = message.channel.id;
  
  // 버퍼에 메시지 추가
  if (!messageBuffer.has(channelId)) {
    messageBuffer.set(channelId, []);
  }
  
  const msgData = {
    id: message.id,
    author: message.author.username,
    user_id: message.author.id,
    content: message.content,
    channel_id: message.channel.id,
    guild_id: message.guild.id,
    timestamp: Date.now(),
    checked: false // 아직 체크 안됨
  };
  
  messageBuffer.get(channelId).push(msgData);
  
  console.log(`📝 [${message.guild.name}] ${message.author.username}: ${message.content.substring(0, 50)}`);
});

// ===== 오래된 메시지 정리 (10분 이상 지난 것) =====
function cleanOldMessages() {
  const cutoffTime = Date.now() - (CONTEXT_WINDOW_MINUTES * 60 * 1000);
  
  for (const [channelId, messages] of messageBuffer.entries()) {
    const filtered = messages.filter(m => m.timestamp > cutoffTime);
    messageBuffer.set(channelId, filtered);
  }
}

// ===== 새 메시지만 필터링 =====
function getNewMessages(messages) {
  return messages.filter(m => !m.checked);
}

// ===== Cloudflare Worker로 메시지 전송 및 체크 =====
async function checkAndSendMessages() {
  let totalChecked = 0;
  
  console.log(`\n⏰ ${new Date().toLocaleTimeString()} - 메시지 체크 시작`);
  
  // 서버별로 그룹화
  const guildGroups = new Map();
  
  for (const [channelId, messages] of messageBuffer.entries()) {
    const newMessages = getNewMessages(messages);
    if (newMessages.length === 0) continue;
    
    const guildId = messages[0]?.guild_id;
    if (!guildId) continue;
    
    if (!guildGroups.has(guildId)) {
      guildGroups.set(guildId, {
        newMessages: [],
        contextMessages: []
      });
    }
    
    // 새 메시지
    guildGroups.get(guildId).newMessages.push(...newMessages);
    
    // 문맥 메시지 (최근 10분 전체)
    guildGroups.get(guildId).contextMessages.push(...messages);
  }
  
  // 서버별로 전송
  for (const [guildId, data] of guildGroups.entries()) {
    try {
      // 중복 제거
      const uniqueContext = Array.from(
        new Map(data.contextMessages.map(m => [m.id, m])).values()
      );
      
      const response = await fetch(`${CLOUDFLARE_WORKER_URL}/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Auth': process.env.AUTH_KEY
        },
        body: JSON.stringify({
          guild_id: guildId,
          new_messages: data.newMessages.map(m => ({
            id: m.id,
            author: m.author,
            user_id: m.user_id,
            content: m.content,
            channel_id: m.channel_id,
            timestamp: new Date(m.timestamp).toISOString()
          })),
          context_messages: uniqueContext.map(m => ({
            author: m.author,
            content: m.content,
            timestamp: new Date(m.timestamp).toISOString()
          }))
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        console.log(`✅ [Guild ${guildId}] 체크: ${result.checked}개 / 위반: ${result.violations}개`);
        totalChecked += result.checked;
        
        // 체크 완료 표시
        data.newMessages.forEach(msg => {
          msg.checked = true;
        });
      } else {
        console.error(`❌ [Guild ${guildId}] 전송 실패: ${response.status}`);
      }
    } catch (error) {
      console.error(`❌ [Guild ${guildId}] 오류:`, error.message);
    }
  }
  
  console.log(`✅ 총 ${totalChecked}개 메시지 체크 완료\n`);
}

// ===== 에러 핸들링 =====
client.on('error', (error) => {
  console.error('❌ Discord 클라이언트 오류:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Promise Rejection:', error);
});

// ===== 봇 시작 =====
client.login(DISCORD_BOT_TOKEN).catch(error => {
  console.error('❌ 봇 로그인 실패:', error);
  process.exit(1);
});

// ===== 종료 처리 =====
process.on('SIGINT', async () => {
  console.log('\n⏹️ 봇 종료 중...');
  await checkAndSendMessages(); // 남은 메시지 전송
  client.destroy();
  process.exit(0);
});

// ===== Keep-Alive 서버 (Render.com Sleep 방지) =====
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`Bot is running! Cached messages: ${Array.from(messageBuffer.values()).reduce((sum, arr) => sum + arr.length, 0)}`);
});
server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Keep-alive 서버 실행 중: Port ${process.env.PORT || 3000}`);
});

console.log('🚀 봇 시작 중...');
