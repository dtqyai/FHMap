#!/bin/zsh
cd -- "${0:A:h}"
port=8763
if /usr/bin/curl --silent --max-time 2 "http://127.0.0.1:${port}/fh3-local-map.json" | /usr/bin/grep -q 'fh3-local-map'; then
  open "http://127.0.0.1:${port}/"
  exit 0
fi
if /usr/sbin/lsof -nP -iTCP:${port} -sTCP:LISTEN >/dev/null 2>&1; then
  print "端口 ${port} 已被其他程序使用。请双击 index.html，或用其他端口启动。"
  read '?按回车关闭…'
  exit 1
fi
if command -v python3 >/dev/null 2>&1; then
  (sleep 1; open "http://127.0.0.1:${port}/") &
  print "FH3 收集地图：http://127.0.0.1:${port}/"
  print "请保留此窗口。按 Control+C 停止本地服务。"
  python3 -m http.server "${port}" --bind 127.0.0.1 --directory .
else
  open index.html
fi
