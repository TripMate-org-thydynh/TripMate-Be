import {
  IntegrityPayload,
  PlayIntegrityService,
} from './play-integrity.service';

/**
 * Phán quyết trên payload đã giải mã. Phần gọi Google không test ở đây — nó
 * chỉ là một request; cái dễ sai là điều kiện chấp nhận.
 */
describe('PlayIntegrityService', () => {
  const NOW = 1_780_000_000_000;
  const DEVICE = 'a1b2c3d4e5f60718';
  const expect_ = {
    packageName: 'com.tripmate.app',
    requestHash: PlayIntegrityService.requestHashFor(DEVICE),
    now: NOW,
  };
  const good = (): IntegrityPayload => ({
    requestDetails: {
      requestPackageName: 'com.tripmate.app',
      requestHash: PlayIntegrityService.requestHashFor(DEVICE),
      timestampMillis: String(NOW - 5_000),
    },
    appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED' },
    deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
  });

  it('payload chuẩn → verified', () => {
    expect(PlayIntegrityService.judge(good(), expect_)).toEqual({
      verified: true,
      reason: 'OK',
    });
  });

  it.each<[string, (p: IntegrityPayload) => void]>([
    ['WRONG_PACKAGE', (p) => (p.requestDetails!.requestPackageName = 'x.y')],
    [
      // Token của máy này ghép với mã của máy khác.
      'HASH_MISMATCH',
      (p) =>
        (p.requestDetails!.requestHash =
          PlayIntegrityService.requestHashFor('may-khac-1234')),
    ],
    [
      'STALE_TOKEN',
      (p) => (p.requestDetails!.timestampMillis = String(NOW - 11 * 60_000)),
    ],
    [
      // App build lại/sửa đổi, không cài từ Play.
      'APP_NOT_RECOGNIZED',
      (p) => (p.appIntegrity!.appRecognitionVerdict = 'UNRECOGNIZED_VERSION'),
    ],
    [
      // Máy ảo / root chỉ đạt BASIC.
      'DEVICE_NOT_TRUSTED',
      (p) =>
        (p.deviceIntegrity!.deviceRecognitionVerdict = [
          'MEETS_BASIC_INTEGRITY',
        ]),
    ],
  ])('%s', (reason, mutate) => {
    const p = good();
    mutate(p);
    expect(PlayIntegrityService.judge(p, expect_)).toEqual({
      verified: false,
      reason,
    });
  });

  it('payload rỗng → không verified, không ném lỗi', () => {
    expect(PlayIntegrityService.judge({}, expect_).verified).toBe(false);
  });

  it('chưa cấu hình khoá → NOT_CONFIGURED, không gọi Google', async () => {
    delete process.env.PLAY_INTEGRITY_SA_KEY;
    const r = await new PlayIntegrityService().verify('tok', DEVICE);
    expect(r).toEqual({ verified: false, reason: 'NOT_CONFIGURED' });
  });

  it('không có token hoặc deviceId → NO_TOKEN', async () => {
    const s = new PlayIntegrityService();
    expect((await s.verify(undefined, DEVICE)).reason).toBe('NO_TOKEN');
    expect((await s.verify('tok', undefined)).reason).toBe('NO_TOKEN');
  });
});
