## Setup
이 프로젝트를 실행하려면 `certs/` 디렉토리에 다음 파일이 필요합니다:
- `privkey.pem`
- `fullchain.pem`
npm install후 npm start하면 rclass의 서버가 작동합니다.

DB설정, 서버 주소 설정은 db/docer-compose.yml과 server/config.js를 참고하여 수정하면 됩니다.

## 디버깅용 webui 사용방법
npm bujild를 실행하면 public 폴더가 생성됩니다.
public 폴더를 nginx에 올리면 디버깅용 UI로 작동합니다.
