# Слой Адаптера и Восстановление (Adapter Layer)

Слой `adapter` отвечает за логическое управление состоянием физического Wi-Fi интерфейса. Во время активных аудитов (AAL, EvilTwin, Deauth) интерфейсы подвергаются экстремальным нагрузкам, что может приводить к сбоям на уровне Kernel Driver (например, паника драйвера `ath9k` или `rtw88`). 

Ядро SORA изолирует эти сбои и пытается разрешить их до того, как Python-оркестратор упадет с критической ошибкой.

## 1. Блокировка Каналов (`channel_lock.rs`)

При обнаружении первого сообщения `EAPOL M1` от целевой точки доступа, SORA должна предотвратить `Channel Hopping` (переключение каналов фоновым сканером), чтобы гарантированно поймать `M2`, `M3` и `M4`.

`ChannelLock` реализует потокобезопасный `Mutex<Option<u8>>`:

```rust
// core/src/adapter/channel_lock.rs
pub struct ChannelLock {
    state: Mutex<Option<u8>>,
}

impl ChannelLock {
    pub fn lock_channel(&self, channel: u8) -> Result<(), ChannelLockError> {
        let mut state = self.state.lock();
        if let Some(locked) = *state {
            return Err(ChannelLockError::AlreadyLocked(locked));
        }
        *state = Some(channel);
        Ok(())
    }
}
```

Когда Python вызывает `cmd_lock_channel`, `PacketEngine` блокирует канал. Любая попытка Python вызвать `cmd_set_channel` будет тихо отклоняться ядром до вызова `UnlockChannel`. Это исключает вероятность потери хэндшейка (Handshake Miss) из-за Race Condition между Python FSM и Rust-ядром.

## 2. Автоматическое восстановление (`error_recovery.rs`)

Механизм `AdapterErrorRecovery` представляет собой Finite State Machine, реагирующую на ошибки типа `ENETDOWN` или `ENODEV` при попытке отправить фрейм или сменить канал.

Система использует **Exponential Backoff** (экспоненциальную задержку) для попыток перезагрузки интерфейса.

```rust
// core/src/adapter/error_recovery.rs
const MAX_RETRIES: u32 = 3;
const BACKOFF_SECS: [u64; 3] = [1, 2, 5];

pub enum RecoveryStatus {
    Recovered,
    Retrying { attempt: u32, next_delay: Duration },
    Failed,
}
```

### Жизненный цикл восстановления:
1. `PacketEngine` ловит `io::Error` при записи в сокет.
2. Инициируется `attempt_recovery`. 
3. Делается попытка выполнить `interface_down` -> `interface_up` через Netlink Controller. Обратный вызов (Callback) `on_status` информирует вызывающий поток.
4. Если статус `Recovered`, процесс продолжается без остановки программы.
5. Если все 3 попытки исчерпаны, возвращается `Failed`, и ядро отправляет фатальное событие `AdapterError` в Python для gracefully shutdown.
