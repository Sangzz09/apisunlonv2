import express from "express"
import axios from "axios"
import cors from "cors"

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000

let history = []
let rawApiData = {}
let predictionLog = []
let loadErrorCount = 0

// ============================================================
// UTILS
// ============================================================
function opp(v) { return v === "Tài" ? "Xỉu" : "Tài" }
function charToResult(ch) { return ch === "T" ? "Tài" : "Xỉu" }
function parsePattern(str) {
  if (!str || typeof str !== "string") return []
  return str.split("").filter(c => c === "T" || c === "X").map(charToResult)
}

// Sinh 3 xúc xắc ngẫu nhiên phù hợp với kết quả Tài/Xỉu
function generateDice(result) {
  while (true) {
    const d = [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1,
    ]
    const sum = d[0] + d[1] + d[2]
    if (result === "Tài" && sum >= 11) return d
    if (result === "Xỉu" && sum <= 10) return d
  }
}

// ============================================================
// ALGO 1: MARKOV CHAIN BẬC 3
// ============================================================
function markov(data) {
  const map3 = {}
  for (let i = 0; i < data.length - 3; i++) {
    const key = data[i]+"_"+data[i+1]+"_"+data[i+2]
    if (!map3[key]) map3[key] = { Tài:0, Xỉu:0 }
    map3[key][data[i+3]]++
  }
  const k3 = data.slice(-3).join("_")
  if (map3[k3]) {
    const m = map3[k3], t = m.Tài + m.Xỉu
    if (t >= 3) return { vote: m.Tài > m.Xỉu ? "Tài":"Xỉu", confidence: Math.max(m.Tài,m.Xỉu)/t, order:3 }
  }
  const map2 = {}
  for (let i = 0; i < data.length - 2; i++) {
    const key = data[i]+"_"+data[i+1]
    if (!map2[key]) map2[key] = { Tài:0, Xỉu:0 }
    map2[key][data[i+2]]++
  }
  const k2 = data.slice(-2).join("_")
  if (map2[k2]) {
    const m = map2[k2], t = m.Tài + m.Xỉu
    if (t >= 3) return { vote: m.Tài > m.Xỉu ? "Tài":"Xỉu", confidence: Math.max(m.Tài,m.Xỉu)/t, order:2 }
  }
  const map1 = { Tài:{Tài:0,Xỉu:0}, Xỉu:{Tài:0,Xỉu:0} }
  for (let i = 0; i < data.length-1; i++) map1[data[i]][data[i+1]]++
  const last = data[data.length-1]
  const m = map1[last], t = m.Tài+m.Xỉu
  if (t===0) return { vote:"Tài", confidence:0.5, order:1 }
  return { vote: m.Tài>m.Xỉu?"Tài":"Xỉu", confidence: Math.max(m.Tài,m.Xỉu)/t, order:1 }
}

// ============================================================
// ALGO 2: EMA TREND
// ============================================================
function trend(data) {
  const w = data.slice(-20)
  let ema = 0.5
  const alpha = 0.18
  let tScore=0, xScore=0
  w.forEach((v,i) => {
    const val = v==="Tài"?1:0
    ema = alpha*val + (1-alpha)*ema
    const weight = Math.pow(1.15, i+1)
    if (v==="Tài") tScore+=weight; else xScore+=weight
  })
  const emaVote = ema>0.5?"Tài":"Xỉu"
  const wVote = tScore>=xScore?"Tài":"Xỉu"
  const vote = emaVote===wVote ? emaVote : (Math.abs(ema-0.5)>0.05 ? emaVote : wVote)
  return { vote, confidence: 0.5+Math.abs(ema-0.5)*0.8 }
}

// ============================================================
// ALGO 3: STREAK
// ============================================================
function streak(data) {
  const last = data[data.length-1]
  let count=0
  for (let i=data.length-1; i>=0; i--) {
    if (data[i]===last) count++; else break
  }
  let vote, confidence
  if (count>=7)      { vote=opp(last); confidence=0.73 }
  else if (count>=5) { vote=last;      confidence=0.66 }
  else if (count>=3) { vote=opp(last); confidence=0.63 }
  else if (count===2){ vote=opp(last); confidence=0.57 }
  else               { vote=last;      confidence=0.52 }
  return { vote, confidence, streakLen:count }
}

// ============================================================
// ALGO 4: MULTI-WINDOW FREQUENCY
// ============================================================
function frequency(data) {
  const apiStats = rawApiData?.thong_ke
  const windows=[10,20,50,100]
  let totalScore=0, weightSum=0
  windows.forEach((w,idx) => {
    let tRatio
    if (w===100 && apiStats?.["100_phien_gan_nhat"]) {
      const s = apiStats["100_phien_gan_nhat"]
      tRatio = s.Tai / (s.Tai + s.Xiu)
    } else {
      const slice = data.slice(-w)
      if (slice.length < w*0.5) return
      tRatio = slice.filter(v=>v==="Tài").length/slice.length
    }
    const weight=[0.4,0.3,0.2,0.1][idx]
    totalScore+=tRatio*weight; weightSum+=weight
  })
  if (weightSum===0) return { vote:"Tài", confidence:0.5 }
  const avg = totalScore/weightSum
  if (avg>0.62) return { vote:"Xỉu", confidence:avg }
  if (avg<0.38) return { vote:"Tài",  confidence:1-avg }
  const t5 = data.slice(-5).filter(v=>v==="Tài").length
  return { vote: t5>=3?"Tài":"Xỉu", confidence:0.5+Math.abs(avg-0.5)*0.3 }
}

// ============================================================
// ALGO 5: MOMENTUM
// ============================================================
function momentum(data) {
  const calcEMA = (arr, period) => {
    const k=2/(period+1)
    let ema=arr[0]==="Tài"?1:0
    for (let i=1;i<arr.length;i++) ema=(arr[i]==="Tài"?1:0)*k+ema*(1-k)
    return ema
  }
  const recent=data.slice(-30)
  if (recent.length<10) return { vote:data[data.length-1], confidence:0.5 }
  const ema5=calcEMA(recent.slice(-5),5)
  const ema12=calcEMA(recent.slice(-12),12)
  const ema26=calcEMA(recent,26)
  const macd=ema12-ema26, signal=ema5-ema12
  let vote
  if (macd>0&&signal>0) vote="Tài"
  else if (macd<0&&signal<0) vote="Xỉu"
  else vote=macd>signal?"Tài":"Xỉu"
  return { vote, confidence:0.52+Math.min(Math.abs(macd)+Math.abs(signal),0.5)*0.5 }
}

// ============================================================
// ALGO 6: PATTERN MATCHING
// ============================================================
function patternMatch(data) {
  const T="Tài", X="Xỉu"
  const patterns = {
    [T+X+T+X+T]:X, [X+T+X+T+X]:T,
    [T+X+T+X]:T,   [X+T+X+T]:X,
    [T+T+T+T+T]:X, [X+X+X+X+X]:T,
    [T+T+T+T]:X,   [X+X+X+X]:T,
    [T+T+T+X]:X,   [X+X+X+T]:T,
    [T+T+X+X+T+T]:X,[X+X+T+T+X+X]:T,
    [T+T+X+X]:T,   [X+X+T+T]:X,
    [T+T+T+X+X+X]:T,[X+X+X+T+T+T]:X,
    [X+T+T+T+X]:T, [T+X+X+X+T]:X,
    [T+X+X+T+T]:X, [X+T+T+X+X]:T,
    [T+T+X+T+T]:X, [X+X+T+X+X]:T,
    [T+T+X+X+T+X]:T,[X+X+T+T+X+T]:X,
    [T+X+T+T+X+T]:X,[X+T+X+X+T+X]:T,
  }
  for (let len=6; len>=3; len--) {
    const key=data.slice(-len).join("")
    if (patterns[key]!==undefined) return { vote:patterns[key], confidence:0.63+len*0.02, detected:key }
  }
  return { vote:null, confidence:0, detected:null }
}

// ============================================================
// ALGO 7: BAYESIAN
// ============================================================
function bayesian(data) {
  for (let n=4; n>=2; n--) {
    const lastN=data.slice(-n).join(",")
    const seqs=[]
    for (let i=0;i<data.length-n;i++) seqs.push({ key:data.slice(i,i+n).join(","), next:data[i+n] })
    const matched=seqs.filter(s=>s.key===lastN)
    if (matched.length>=3) {
      const tAfter=matched.filter(s=>s.next==="Tài").length
      const prob=tAfter/matched.length
      return { vote:prob>=0.5?"Tài":"Xỉu", confidence:0.5+Math.abs(prob-0.5)*(0.3+n*0.05), samples:matched.length }
    }
  }
  const tRatio=data.slice(-100).filter(v=>v==="Tài").length/Math.min(data.length,100)
  return { vote:tRatio>=0.5?"Tài":"Xỉu", confidence:0.5+Math.abs(tRatio-0.5)*0.2 }
}

// ============================================================
// ALGO 8: ENTROPY
// ============================================================
function entropyAnalysis(data) {
  const w=data.slice(-20)
  let switches=0
  for (let i=1;i<w.length;i++) if (w[i]!==w[i-1]) switches++
  const entropyRatio=switches/(w.length-1)
  if (entropyRatio>0.72) {
    const t=data.slice(-4).filter(v=>v==="Tài").length
    return { vote:t>=2?"Tài":"Xỉu", confidence:0.54, entropy:entropyRatio }
  } else if (entropyRatio<0.28) {
    return { vote:data[data.length-1], confidence:0.65, entropy:entropyRatio }
  }
  const score=data.slice(-5).reduce((s,v,i)=>s+(v==="Tài"?1:-1)*(i+1),0)
  return { vote:score>0?"Tài":"Xỉu", confidence:0.53, entropy:entropyRatio }
}

// ============================================================
// ALGO 9: MEAN REVERSION
// ============================================================
function meanReversion(data) {
  const tRatio=data.slice(-30).filter(v=>v==="Tài").length/Math.min(data.length,30)
  const dev=tRatio-0.5
  if (Math.abs(dev)<0.1) return { vote:data[data.length-1], confidence:0.5 }
  return { vote:dev>0?"Xỉu":"Tài", confidence:Math.min(0.5+Math.abs(dev)*0.6,0.75) }
}

// ============================================================
// ALGO 10: LSTM-INSPIRED
// ============================================================
function lstmInspired(data) {
  const seqLen=6
  if (data.length<seqLen+10) return { vote:data[data.length-1], confidence:0.5 }
  const encode=v=>v==="Tài"?1:0
  const cur=data.slice(-seqLen).map(encode)
  let tScore=0, xScore=0, totalW=0
  for (let i=0;i<=data.length-seqLen-1;i++) {
    const seq=data.slice(i,i+seqLen).map(encode)
    let dot=0, magA=0, magB=0
    for (let j=0;j<seqLen;j++) { dot+=cur[j]*seq[j]; magA+=cur[j]*cur[j]; magB+=seq[j]*seq[j] }
    const sim=magA&&magB?dot/(Math.sqrt(magA)*Math.sqrt(magB)):0
    if (sim>0.6) {
      const next=data[i+seqLen], w=sim*sim
      if (next==="Tài") tScore+=w; else xScore+=w
      totalW+=w
    }
  }
  if (totalW<0.5) return { vote:data[data.length-1], confidence:0.5 }
  const prob=tScore/totalW
  return { vote:prob>=0.5?"Tài":"Xỉu", confidence:0.5+Math.abs(prob-0.5)*0.7 }
}

// ============================================================
// ADAPTIVE WEIGHTS
// ============================================================
const algorithmWeights = {
  markov:1.2, trend:1.0, streak:1.0, frequency:0.8,
  momentum:1.0, pattern:1.6, bayesian:1.3,
  entropy:0.9, meanReversion:0.8, lstm:1.1,
}

function updateWeights(log) {
  const recent=log.filter(e=>e.actual).slice(-40)
  if (recent.length<10) return
  Object.keys(algorithmWeights).forEach(algo => {
    const entries=recent.filter(e=>e.votes&&e.votes[algo]&&e.actual)
    if (entries.length<5) return
    const acc=entries.filter(e=>e.votes[algo]===e.actual).length/entries.length
    const newW=Math.max(0.3,Math.min(2.5,acc*2.2))
    algorithmWeights[algo]=algorithmWeights[algo]*0.7+newW*0.3
  })
}

// ============================================================
// ENSEMBLE
// ============================================================
function aiPredict(results) {
  if (results.length<10) return { predict:"Tài", conf:50, signal:"weak", votes:{} }

  const mk=markov(results), tr=trend(results), sk=streak(results)
  const fr=frequency(results), mm=momentum(results), pt=patternMatch(results)
  const by=bayesian(results), en=entropyAnalysis(results)
  const mr=meanReversion(results), ls=lstmInspired(results)

  const votes={ markov:mk.vote, trend:tr.vote, streak:sk.vote, frequency:fr.vote,
    momentum:mm.vote, pattern:pt.vote, bayesian:by.vote, entropy:en.vote,
    meanReversion:mr.vote, lstm:ls.vote }

  const conf={ markov:mk.confidence, trend:tr.confidence, streak:sk.confidence,
    frequency:fr.confidence, momentum:mm.confidence,
    pattern:pt.detected?pt.confidence:0.5, bayesian:by.confidence,
    entropy:en.confidence, meanReversion:mr.confidence, lstm:ls.confidence }

  let tScore=0, xScore=0
  Object.keys(votes).forEach(algo => {
    if (!votes[algo]) return
    const w=algorithmWeights[algo]*Math.pow(conf[algo]||0.5,1.3)
    if (votes[algo]==="Tài") tScore+=w; else xScore+=w
  })

  const total=tScore+xScore
  const predict=tScore>xScore?"Tài":"Xỉu"
  const rawConf=Math.max(tScore,xScore)/total
  const confPct=Math.round(50+rawConf*38)

  const validVotes=Object.values(votes).filter(Boolean)
  const tVotes=validVotes.filter(v=>v==="Tài").length
  const consensus=Math.abs(tVotes*2-validVotes.length)/validVotes.length
  const signal=consensus>=0.65?"strong":consensus>=0.35?"moderate":"weak"

  // Phân loại cầu đơn giản
  const sk2=streak(results)
  let loaiCau
  if (sk2.streakLen>=4) {
    loaiCau = sk2.vote===results[results.length-1] ? `Bệt ${results[results.length-1]}` : `Gãy ${results[results.length-1]}`
  } else {
    const tRatio=results.slice(-20).filter(v=>v==="Tài").length/20
    if (tRatio>0.6)       loaiCau="Nghiêng Tài"
    else if (tRatio<0.4)  loaiCau="Nghiêng Xỉu"
    else                  loaiCau="Cân bằng"
  }

  return { predict, conf:confPct, signal, loaiCau, votes, streakLen:sk2.streakLen }
}

// ============================================================
// DEEP CẦU ANALYSIS
// ============================================================
function deepCauAnalysis(arr) {
  if (arr.length<6) return { name:"chưa_đủ_dữ_liệu", predict:null, confidence:50 }

  const w=arr.slice(-20)
  const last=w[w.length-1]

  let streakLen=0
  for (let i=w.length-1;i>=0;i--) { if(w[i]===last) streakLen++; else break }

  const detectPeriod=(arr)=>{
    for (let p=2;p<=6;p++) {
      const tail=arr.slice(-p*2)
      if (tail.length<p*2) continue
      if (tail.slice(0,p).join(",")===tail.slice(p).join(",")) return p
    }
    return null
  }
  const period=detectPeriod(w)

  const alternatingLen=(()=>{
    let len=1
    const last8=w.slice(-8)
    for (let i=last8.length-2;i>=0;i--) {
      if(last8[i]!==last8[i+1]) len++; else break
    }
    return len
  })()

  if (streakLen>=3) {
    const predict=streakLen>=6?opp(last):streakLen>=4?opp(last):last
    return { name: streakLen>=4?"Bệt dài":"Bệt ngắn", predict, confidence:Math.min(62+streakLen*2,82), streak:streakLen }
  }
  if (alternatingLen>=4) return { name:"Đan xen", predict:opp(last), confidence:Math.min(65+alternatingLen*2,82) }
  if (period) return { name:`Chu kỳ ${period}`, predict:w.slice(-period)[0], confidence:68+period }

  const checkPatterns=(patterns)=>{
    for (const p of patterns) {
      if (w.slice(-p.seq.length).join(",")===p.seq.join(",")) return p
    }
    return null
  }
  const p12=checkPatterns([
    { seq:["Tài","Xỉu","Xỉu","Tài","Xỉu","Xỉu"], next:"Tài", name:"Cầu 1-2" },
    { seq:["Xỉu","Tài","Tài","Xỉu","Tài","Tài"],  next:"Xỉu", name:"Cầu 1-2" },
    { seq:["Tài","Xỉu","Xỉu","Tài"],               next:"Xỉu", name:"Cầu 1-2" },
    { seq:["Xỉu","Tài","Tài","Xỉu"],               next:"Tài", name:"Cầu 1-2" },
  ])
  if (p12) return { name:p12.name, predict:p12.next, confidence:67 }

  const p22=checkPatterns([
    { seq:["Tài","Tài","Xỉu","Xỉu","Tài","Tài"], next:"Xỉu", name:"Cầu 2-2" },
    { seq:["Xỉu","Xỉu","Tài","Tài","Xỉu","Xỉu"], next:"Tài", name:"Cầu 2-2" },
  ])
  if (p22) return { name:p22.name, predict:p22.next, confidence:68 }

  const tRatio=arr.slice(-20).filter(v=>v==="Tài").length/20
  if (tRatio>0.6) return { name:"Nghiêng Tài", predict:"Tài", confidence:60 }
  if (tRatio<0.4) return { name:"Nghiêng Xỉu", predict:"Xỉu", confidence:60 }

  return { name:"Không rõ cầu", predict:null, confidence:50 }
}

// ============================================================
// FETCH DATA
// ============================================================
async function load() {
  try {
    const url = `https://sunlaymaynkx.hacksieucap.pro/ttsunver2?t=${Date.now()}`
    const r = await axios.get(url, {
      timeout: 6000,
      headers: { "User-Agent": "SicboAI/3.0", "Accept": "application/json" }
    })
    const body = r.data
    if (!body || typeof body !== "object") { console.error("❌ Response không hợp lệ"); return }

    rawApiData = body

    const fullPattern =
      body.pattern ||
      body.pattern_recent_100 ||
      body.pattern_recent_50  ||
      body.pattern_recent_20  || ""

    if (!fullPattern) { console.error("❌ Không tìm thấy pattern"); return }

    const newHistory = parsePattern(fullPattern)
    if (newHistory.length === 0) { console.error("❌ Parse pattern rỗng"); return }

    const currentPhien = body.phien || 0
    loadErrorCount = 0

    if (predictionLog.length > 0) {
      const lastEntry = predictionLog[predictionLog.length - 1]
      if (!lastEntry.actual && lastEntry.phien !== currentPhien) {
        if (newHistory.length >= 2) {
          lastEntry.actual = newHistory[newHistory.length - 1]
          updateWeights(predictionLog)
          console.log(`✅ Actual phiên ${lastEntry.phien}: ${lastEntry.actual}`)
        }
      }
    }

    history = newHistory
    console.log(`📦 Phiên ${currentPhien} | Lịch sử: ${history.length} phiên`)
  } catch(e) {
    loadErrorCount++
    if (e.response)                   console.error(`❌ HTTP ${e.response.status}`)
    else if (e.code==="ECONNABORTED") console.error("❌ Timeout")
    else                              console.error("❌ Load error:", e.message)
    if (loadErrorCount <= 5) setTimeout(load, 2000)
  }
}

load()
setInterval(load, 5000)

// ============================================================
// HELPER: tạo chuỗi pattern T/X từ history
// ============================================================
function buildPatternStr(arr, len=20) {
  return arr.slice(-len).map(v => v==="Tài"?"T":"X").join("")
}

// ============================================================
// ROUTES
// ============================================================

// Route chính
app.get("/api", (req, res) => {
  if (history.length === 0) return res.status(503).json({ error:"no_data" })

  const arr = history
  const ai = aiPredict(arr)
  const currentPhien = String(rawApiData?.phien || 0)
  const phienDuDoan  = String(rawApiData?.phien_dudoan || (Number(currentPhien) + 1))
  const xucXac = generateDice(ai.predict)

  const lastLog = predictionLog[predictionLog.length - 1]
  if (!lastLog || lastLog.phien !== currentPhien) {
    predictionLog.push({ phien:currentPhien, predict:ai.predict, actual:null, votes:ai.votes, timestamp:Date.now() })
    if (predictionLog.length > 200) predictionLog.shift()
  }

  res.json({
    phien: currentPhien,
    xuc_xac: xucXac,
    phien_hien_tai: phienDuDoan,
    du_doan: ai.predict,
    do_tin_cay: ai.conf + "%",
    loai_cau: ai.loaiCau,
    pattern: buildPatternStr(arr, 20),
    dev: "@sewdangcap"
  })
})

// Route sunlon (dùng deep cầu analysis)
app.get("/sunlon", (req, res) => {
  if (history.length === 0) return res.status(503).json({ error:"no_data" })

  const arr = history
  const cau = deepCauAnalysis(arr)
  const currentPhien = String(rawApiData?.phien || 0)
  const phienDuDoan  = String(rawApiData?.phien_dudoan || (Number(currentPhien) + 1))

  let duDoan = cau.predict, doTinCay = cau.confidence || 65
  if (!duDoan) {
    const ai = aiPredict(arr)
    duDoan = ai.predict
    doTinCay = ai.conf
  }

  const xucXac = generateDice(duDoan)

  res.json({
    phien: currentPhien,
    xuc_xac: xucXac,
    phien_hien_tai: phienDuDoan,
    du_doan: duDoan,
    do_tin_cay: doTinCay + "%",
    loai_cau: cau.name,
    pattern: buildPatternStr(arr, 20),
    dev: "@sewdangcap"
  })
})

// Các route phụ giữ nguyên (detail, accuracy, history, health)
app.get("/sunlon/detail", (req, res) => {
  if (history.length === 0) return res.status(503).json({ error:"no_data" })
  const arr = history
  const cau = deepCauAnalysis(arr)
  const ai  = aiPredict(arr)
  res.json({
    cau:{ name:cau.name, predict:cau.predict, confidence:(cau.confidence||50)+"%", streak:cau.streak||null },
    ai:{ predict:ai.predict, confidence:ai.conf+"%", signal:ai.signal, votes:ai.votes },
    lich_su_15: arr.slice(-15),
    thong_ke: rawApiData?.thong_ke || null,
    dev: "@sewdangcap"
  })
})

app.get("/api/detail", (req, res) => {
  if (history.length === 0) return res.status(503).json({ error:"no_data" })
  const arr = history
  const ai  = aiPredict(arr)
  res.json({
    total_sessions: history.length,
    ai_detail: ai,
    recent_10: arr.slice(-10),
    algorithm_weights: algorithmWeights,
    dev: "@sewdangcap"
  })
})

app.get("/api/accuracy", (req, res) => {
  const evaluated = predictionLog.filter(e => e.actual)
  if (evaluated.length === 0) return res.json({ message:"Chưa đủ dữ liệu", total:0 })
  const correct = evaluated.filter(e => e.predict === e.actual).length
  const algoStats = {}
  Object.keys(algorithmWeights).forEach(algo => {
    const algoEval    = evaluated.filter(e => e.votes && e.votes[algo])
    const algoCorrect = algoEval.filter(e => e.votes[algo] === e.actual).length
    algoStats[algo] = {
      accuracy: algoEval.length > 0 ? Math.round(algoCorrect/algoEval.length*100)+"%" : "N/A",
      weight: Math.round(algorithmWeights[algo]*100)/100
    }
  })
  res.json({
    total_evaluated: evaluated.length,
    correct,
    accuracy: Math.round(correct/evaluated.length*100)+"%",
    algorithm_stats: algoStats,
    recent_20: evaluated.slice(-20).map(e => ({ phien:e.phien, predict:e.predict, actual:e.actual, correct:e.predict===e.actual }))
  })
})

app.get("/api/history", (req, res) => {
  if (history.length === 0) return res.status(503).json({ error:"no_data" })
  const arr    = history
  const last50 = arr.slice(-50)
  const tCount = last50.filter(v => v==="Tài").length
  res.json({
    total: history.length,
    recent_50: last50,
    tai_ratio:  Math.round(tCount/last50.length*100)+"%",
    xiu_ratio:  Math.round((last50.length-tCount)/last50.length*100)+"%"
  })
})

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    history_loaded: history.length,
    prediction_log: predictionLog.length,
    load_errors: loadErrorCount,
    current_phien: rawApiData?.phien || null
  })
})

app.listen(PORT, () => {
  console.log(`🎲 SICBO ULTRA AI v3 RUNNING on port ${PORT}`)
})
