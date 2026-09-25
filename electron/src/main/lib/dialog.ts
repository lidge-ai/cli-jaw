import { dialog, shell } from 'electron';

export type JawNotFoundChoice = 'guide' | 'pick' | 'quit';

const INSTALL_GUIDE_URL = 'https://github.com/lidge-ai/cli-jaw#installation';

export async function showJawNotFoundDialog(
  searched: string[],
): Promise<JawNotFoundChoice> {
  const result = await dialog.showMessageBox({
    type: 'error',
    title: 'jaw CLI를 찾을 수 없습니다',
    message: 'jaw CLI를 찾을 수 없습니다',
    detail:
      '다음 경로를 확인했지만 jaw CLI를 찾지 못했습니다:\n\n' +
      searched.map((p) => `  • ${p}`).join('\n') +
      '\n\nnpm install -g cli-jaw 로 설치하거나, 직접 경로를 선택해 주세요.',
    buttons: ['설치 안내 열기', 'jaw 경로 선택', '종료'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  switch (result.response) {
    case 0:
      await shell.openExternal(INSTALL_GUIDE_URL);
      return 'guide';
    case 1:
      return 'pick';
    default:
      return 'quit';
  }
}

export async function showCrashLoopDialog(logTail: string): Promise<void> {
  await dialog.showMessageBox({
    type: 'error',
    title: 'jaw dashboard 서버 시작 실패',
    message: 'jaw dashboard 서버가 반복적으로 종료되었습니다',
    detail:
      '60초 안에 3회 이상 비정상 종료되어 자동 재시작을 중단했습니다.\n\n' +
      '최근 로그 (tail):\n' +
      (logTail.slice(-2000) || '(no output)'),
    buttons: ['확인'],
    defaultId: 0,
    noLink: true,
  });
}

export async function showSpawnFailedDialog(message: string): Promise<void> {
  await dialog.showMessageBox({
    type: 'error',
    title: 'jaw dashboard 시작 실패',
    message: 'jaw dashboard 서버를 시작할 수 없습니다',
    detail: message,
    buttons: ['확인'],
    defaultId: 0,
    noLink: true,
  });
}
