# Compliance & Regulatory Standards / Соответствие стандартам

English | [Русский](#ru-соответствие-информационной-безопасности)

---

## (EN) Security Audit Compliance

**SORA (Signals Offensive Radio Auditor)** is designed to assist security professionals in meeting regulatory requirements for wireless infrastructure monitoring and penetration testing.

### 1. PCI DSS v3.2.1 / v4.0 (Requirement 11)
- **Rogue AP Detection (11.2)**: SORA's continuous scanning and `Passive Sniffing` capabilities exceed the standard for identifying unauthorized wireless access points.
- **Penetration Testing (11.3)**: Automating the assessment of Wi-Fi encryption (WPA2/WPA3) and authentication mechanisms directly addresses the requirement for annual external/internal penetration testing.

### 2. ISO/IEC 27001:2022 (A.12.6.1)
- **Technical Vulnerability Management**: SORA provides structured auditing of the wireless perimeter, fulfilling the requirement for proactive detection and management of vulnerabilities in network infrastructure.

### 3. SOC 2 (Security & Confidentiality)
- **Access Control Monitoring**: SORA's `Karma/Mana` engines can be used to simulate and verify that corporate devices are not automatically connecting to untrusted networks, ensuring confidentiality and integrity of data.

### 4. HIPAA / HITECH
- **Transmission Security**: Verification of WPA3 (SAE) implementation and handshake capture validates that Protected Health Information (PHI) is protected by industry-standard encryption during wireless transmission.

### 5. Stealth vs. Clandestine Operation
- **Purpose of StealthEngine**: The traffic obfuscation features (OUI spoofing, interval jitter) are designed to test the effective detection range and sensitivity of **Wireless Intrusion Detection Systems (WIDS/IDS)**.
- **Hardware Agnosticism**: SORA is a software framework that operates via standard operating system network interfaces (`AF_PACKET`, `nl80211`). It does not require or include hardware modifications that transform common Wi-Fi adapters into clandestine surveillance devices.
- **Non-Clandestine Nature**: SORA is an interactive auditing tool and does not provide "secret" or "hidden" installation/operation modes. It is not intended for clandestine information gathering (Ref: [Disclaimer](./DISCLAIMER.md#6-special-technical-means-stm--clandestine-surveillance)).

---

## (RU) Соответствие информационной безопасности

**SORA (Signals Offensive Radio Auditor)** спроектирована для помощи специалистам по ИБ в выполнении требований нормативных документов по мониторингу беспроводной инфраструктуры и проведению тестов на проникновение.

### 1. PCI DSS v3.2.1 / v4.0 (Требование 11)
- **Rogue AP Detection (11.2)**: Возможности SORA по непрерывному сканированию и пассивному перехвату эфира значительно упрощают поиск несанкционированных точек доступа.
- **Тестирование на проникновение (11.3)**: Автоматизация аудита шифрования (WPA2/WPA3) и механизмов аутентификации напрямую закрывает требование по ежегодному проведению внешних и внутренних тестов на проникновение.

### 2. ISO/IEC 27001:2022 (A.12.6.1)
- **Управление техническими уязвимостями**: SORA обеспечивает структурированный аудит беспроводного периметра, выполняя требование по проактивному обнаружению и управлению уязвимостями в сетевой инфраструктуре.

### 3. SOC 2 (Безопасность и Конфиденциальность)
- **Мониторинг контроля доступа**: Движки `Karma/Mana` могут быть использованы для верификации того, что корпоративные устройства не подключаются автоматически к недоверенным сетям, гарантируя конфиденциальность и целостность данных.

### 4. HIPAA / HITECH
- **Безопасность передачи данных**: Проверка внедрения WPA3 (SAE) и захват хэндшейков подтверждает, что защищенная медицинская информация (PHI) защищена стандартным для отрасли шифрованием при беспроводной передаче.

### 5. Скрытность vs Негласное использование
- **Назначение StealthEngine**: Функции маскировки трафика (OUI-спуфинг, джиттер интервалов) предназначены для проверки эффективной дальности и чувствительности **систем обнаружения вторжений (WIDS/IDS)**.
- **Стандартные интерфейсы**: SORA работает исключительно со стандартными сетевыми интерфейсами ОС (`AF_PACKET`, `nl80211`). ПО не требует и не содержит аппаратных модификаций, превращающих обычные Wi-Fi адаптеры в устройства для негласного наблюдения.
- **Открытый характер работы**: SORA является интерактивным инструментом аудита и не предусматривает скрытых режимов установки или работы. ПО не предназначено для негласного получения информации (См: [Дисклеймер](./DISCLAIMER.md#6-специальные-технические-средства-стс)).
