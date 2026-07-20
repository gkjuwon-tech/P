import app from "./app.js";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`\n  🟢 지분 베스팅 앱 실행 중: http://localhost:${PORT}`);
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log("  ⚠️  DEEPSEEK_API_KEY 미설정 → 목(mock) 평가 모드로 동작합니다.\n");
  } else {
    console.log("  ✅ Deepseek API 연동됨.\n");
  }
});
