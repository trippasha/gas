// Оскільки цей файл є класичним скриптом, ми використовуємо 'await import'
// для отримання функцій Firestore усередині async-функцій.

class GasMonitor {
    constructor() {
        // Перевіряємо, чи ініціалізовано Firebase
        if (!window.db) {
            console.error("Firebase Firestore не доступно. Перевірте index.html.");
            return;
        }
        this.db = window.db;
        this.data = []; // Дані, завантажені з Firebase
        this.collectionName = "gas_readings";
        this.showAll = false;
        this.defaultDays = 15;
        this.detailChartInstance = null;

    // ДОДАНО: масив для сирих даних з сенсорів та підписка на onSnapshot
    // ts зберігається як Date (UTC), але при зчитуванні віднімаємо 1 годину
    this.sensorData = [];        // { ts: Date, indoor_t: number, outdoor_t: number }
        this.sensorUnsubscribe = null;
    // external temps from API: dateStr -> temp
    this.externalTemps = {};
    this.externalTempsLoaded = false;
    }

    // Завантажити середні добові температури із Open-Meteo archive API
    async loadExternalDailyTemps() {
        try {
            // Фіксована start_date як у прикладі, end_date — вчора відносно локальної дати
            const startDate = '2025-11-23';
            const y = new Date();
            y.setDate(y.getDate() - 1);
            const endDate = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2,'0')}-${String(y.getDate()).padStart(2,'0')}`;

            const lat = '49.805233';
            const lon = '24.147206';
            const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_mean&timezone=auto`;

            console.debug('[GasMonitor] loadExternalDailyTemps: fetching', url);
            const resp = await fetch(url);
            if (!resp.ok) {
                console.warn('[GasMonitor] loadExternalDailyTemps: fetch failed', resp.status, resp.statusText);
                this.externalTemps = {};
                this.externalTempsLoaded = false;
                return;
            }

            const data = await resp.json();
            const times = (data && data.daily && data.daily.time) || [];
            const temps = (data && data.daily && data.daily.temperature_2m_mean) || [];

            this.externalTemps = {};
            for (let i = 0; i < Math.min(times.length, temps.length); i++) {
                const t = times[i];
                const v = temps[i];
                this.externalTemps[t] = (v === null || v === undefined) ? null : Number(v);
            }
            this.externalTempsLoaded = Object.keys(this.externalTemps).length > 0;
            console.debug('[GasMonitor] loadExternalDailyTemps: loaded days=', Object.keys(this.externalTemps).length);
            // Перерендеримо, щоб графіки оновились
            this.render();
        } catch (err) {
            console.error('[GasMonitor] loadExternalDailyTemps error:', err);
            this.externalTemps = {};
            this.externalTempsLoaded = false;
        }
    }

    async init() {
        // Встановити дату
        this.setMinDate();

        // 1) Підписка / завантаження sensor_data (щоб мати температури при побудові графіків)
        await this.loadSensorDataFromFirebase();

        // 2) Завантажуємо дані газу
        await this.loadGasDataFromFirebase();

        // 2.5) Завантажуємо зовнішні середні температури з Open-Meteo (archive)
        await this.loadExternalDailyTemps();

        // 3) Слухачі та рендер
        this.setupEventListeners();
        this.render();
        this.renderDetailedChart(7); // початковий період — 7 днів у детальному табі
    }
	setupEventListeners() { 
        const dataForm = document.getElementById('dataForm');
        if (dataForm) {
            dataForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.addData();
            });
		}

        // Toggle Show All
        const toggleBtn = document.getElementById('toggleShowAll');
        if (toggleBtn) {
            // Встановимо початковий текст відповідно до стану
            const updateToggleText = () => {
                toggleBtn.textContent = this.showAll ? 'Показати останні 15 дн.' : 'Показати всі дані';
                toggleBtn.setAttribute('aria-pressed', String(this.showAll));
            };
            updateToggleText();

            // Підключаємо слухач для кліку. Використовуємо preventDefault() на випадок, якщо кнопка має тип submit
            toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.showAll = !this.showAll;
                updateToggleText();
                console.debug('[GasMonitor] toggleShowAll clicked, showAll=', this.showAll);
                // Оновити графік
                this.render();
            });
        }

        // Tab switching
        const tabOverview = document.getElementById('tabOverview');
        const tabDetail = document.getElementById('tabDetail');
        const overviewPanel = document.getElementById('overviewPanel');
        const detailPanel = document.getElementById('detailPanel');

        if (tabOverview && tabDetail) {
            tabOverview.addEventListener('click', () => {
                tabOverview.setAttribute('aria-pressed','true');
                tabDetail.setAttribute('aria-pressed','false');
                overviewPanel.style.display = '';
                detailPanel.style.display = 'none';
                this.render(); // оновити overview
            });
            tabDetail.addEventListener('click', () => {
                tabOverview.setAttribute('aria-pressed','false');
                tabDetail.setAttribute('aria-pressed','true');
                overviewPanel.style.display = 'none';
                detailPanel.style.display = '';
                // Відобразити детальний графік (залишаємо поточний період)
                this.renderDetailedChart(7);
            });
        }

        // Period buttons in detail panel
        const periodButtons = document.querySelectorAll('.period-btn');
        periodButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const days = parseInt(btn.getAttribute('data-days'), 10) || 7;
                // Відобразити детальний графік з вибраним періодом
                this.renderDetailedChart(days);
            });
        });

        // Слухач для видалення також знаходиться в renderTable через onclick
    }
    // Функція для завантаження всіх даних з Firestore
    // ЗАМІНЕНО: loadGasDataFromFirebase — безпечний парсинг timestamp і збереження Date або null
	async loadGasDataFromFirebase() {
		try {
			const { collection, query, orderBy, getDocs } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
			const q = query(collection(this.db, this.collectionName), orderBy("timestamp", "asc"));

			const querySnapshot = await getDocs(q);
			const loadedData = [];

			querySnapshot.forEach((doc) => {
				const data = doc.data();

				// Нормалізація timestamp: рядок ISO/"YYYY-MM-DD HH:MM:SS", Firestore Timestamp, Date, number
				let ts = null;
				if (data.timestamp) {
					if (typeof data.timestamp === 'string') {
						// пробіл -> T для більшості форматів
						let s = data.timestamp.replace(' ', 'T');
						let parsed = new Date(s);
						if (isNaN(parsed.getTime())) parsed = new Date(Date.parse(data.timestamp));
						if (isNaN(parsed.getTime())) parsed = new Date(data.timestamp); // ще одна спроба
						ts = isNaN(parsed.getTime()) ? null : parsed.getTime();
					} else if (typeof data.timestamp === 'number') {
						ts = data.timestamp;
					} else if (data.timestamp && data.timestamp.toDate) {
						try { ts = data.timestamp.toDate().getTime(); } catch (e) { ts = null; }
					} else if (data.timestamp instanceof Date) {
						ts = data.timestamp.getTime();
					}
				}

				loadedData.push({
					id: doc.id,
					date: data.date,
					gasReading: data.gasReading,
					temperature: (data.temperature !== undefined && data.temperature !== null) ? Number(data.temperature) : null,
					// зберігаємо Date або null
					timestamp: ts ? new Date(ts) : null
				});
			});

			this.data = loadedData;
			this.render();
		} catch (error) {
			console.error("Помилка завантаження даних з Firebase:", error);
			alert("Помилка завантаження даних. Перевірте консоль.");
		}
	}

    // Функція для збереження даних у Firestore
    async saveGasDataToFirebase(newEntry) {
        try {
            const { collection, addDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
            
            const dataToSave = {
                date: newEntry.date,
                gasReading: newEntry.gasReading,
                temperature: newEntry.temperature,
                timestamp: serverTimestamp() // Час, встановлений сервером
            };

            const docRef = await addDoc(collection(this.db, this.collectionName), dataToSave);
            
            // Додаємо новий запис з ID до локального масиву для негайного відображення
            this.data.push({
                ...newEntry, 
                id: docRef.id,
                timestamp: new Date() // Використовуємо New Date() для негайного відображення
            }); 
            
            this.render();

        } catch (error) {
            console.error("Помилка запису даних до Firebase:", error);
            alert("Помилка збереження даних. Перевірте консоль.");
        }
    }
    
    // Функція для видалення даних з Firestore
    async deleteDataFromFirebase(docId) {
        try {
            const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
            
            await deleteDoc(doc(this.db, this.collectionName, docId));
            
            // Видаляємо з локального масиву
            this.data = this.data.filter(entry => entry.id !== docId);
            
            this.render();

        } catch (error) {
            console.error("Помилка видалення даних з Firebase:", error);
            alert("Помилка видалення даних. Перевірте консоль.");
        }
    }
    
    // --- Модифікація існуючих методів ---
    
    // Викликається після loadGasDataFromFirebase
    render() {
        // Оновити коротку статистику перед рендером таблиці/графіків
        this.updateSummary();
        this.renderTable();
        this.renderChart();
        // Якщо зараз відкрито детальний таб — оновимо його також
        const detailPanel = document.getElementById('detailPanel');
        if (detailPanel && detailPanel.style.display !== 'none') {
            // залишимо період 7 днів для оновлення
            this.renderDetailedChart(7);
        }
    }

    // Повертає сумарне використання та середню витрату на добу,
    // загальне використання рахуємо за ВСІМИ показниками, середню — без перших 4 записів
    computeSummaryMetrics() {
        const allData = this.getAllData() || [];
        const excludeCount = 4; // не враховуємо перші 4 для середньої

        // Сумуємо загальне використання по всіх записах (тільки позитивні дельти)
        const totalUsed = allData.reduce((acc, e) => acc + (e.difference > 0 ? Number(e.difference) : 0), 0);

        const considered = allData.slice(excludeCount);

        if (!considered || considered.length === 0) {
            console.debug('[GasMonitor] computeSummaryMetrics: not enough considered records, allData.length=', allData.length);
            return { totalUsed, avgPerDay: 0, days: 0, firstDate: null, lastDate: null };
        }

        // Обчислимо часовий інтервал між першою та останньою точками у розглянутому наборі
        const tryParseDate = (e) => {
            if (e && e.timestamp instanceof Date) return e.timestamp.getTime();
            if (!e) return null;
            // Спроби парсингу — кілька форматів, щоб покрити мобільні браузери
            let t = null;
            try {
                const d1 = new Date(e.date);
                if (!isNaN(d1.getTime())) return d1.getTime();
            } catch (err) { /* ignore */ }
            try {
                const d2 = new Date(String(e.date) + 'T00:00:00');
                if (!isNaN(d2.getTime())) return d2.getTime();
            } catch (err) { /* ignore */ }
            try {
                const p = Date.parse(e.date);
                if (!isNaN(p)) return p;
            } catch (err) { /* ignore */ }
            return t;
        };

        const times = considered.map(tryParseDate).filter(t => t !== null).sort((a,b)=>a-b);
        // Якщо часів не знайдено (біда з парсингом на мобільному), використаємо запасний підхід: days = кількість записів
        if (times.length === 0) {
            const consideredTotal = considered.reduce((acc,e) => acc + (e.difference > 0 ? Number(e.difference) : 0), 0);
            const days = Math.max(1, considered.length);
            console.debug('[GasMonitor] computeSummaryMetrics: fallback days used=', days, 'considered.length=', considered.length);
            return { totalUsed, avgPerDay: consideredTotal / days, days, firstDate: null, lastDate: null };
        }

        const first = times[0];
        const last = times[times.length - 1];
        // кількість діб (округлюємо вгору, щоб часткова доба враховувалась як повна)
        const days = Math.max(1, Math.ceil((last - first) / (24 * 60 * 60 * 1000)));
        const consideredTotal = considered.reduce((acc,e) => acc + (e.difference > 0 ? Number(e.difference) : 0), 0);
        const avgPerDay = consideredTotal / days;

        return { totalUsed, avgPerDay, days, firstDate: new Date(first), lastDate: new Date(last) };
    }

    updateSummary() {
        const elTotal = document.getElementById('summaryTotalUsed');
        const elAvg = document.getElementById('summaryAvgPerDay');
        if (!elTotal || !elAvg) return;

        const { totalUsed, avgPerDay, days, firstDate, lastDate } = this.computeSummaryMetrics();
        console.debug('[GasMonitor] updateSummary:', { totalUsed, avgPerDay, days, firstDate, lastDate });

        elTotal.textContent = (totalUsed !== null && !isNaN(totalUsed)) ? `${totalUsed.toFixed(2)} м³` : '—';
        elAvg.textContent = (avgPerDay !== null && !isNaN(avgPerDay)) ? `${avgPerDay.toFixed(2)} м³/доба` : '—';

        if (firstDate && lastDate) {
            elTotal.title = `Період: ${firstDate.toLocaleDateString('uk-UA')} — ${lastDate.toLocaleDateString('uk-UA')}`;
            elAvg.title = `Розраховано за ${days} дн.`;
        } else {
            elTotal.title = '';
            elAvg.title = '';
        }
    }

    // addData тепер асинхронний і викликає saveGasDataToFirebase
    async addData() {
        const date = document.getElementById('date').value;
        const gasReading = parseFloat(document.getElementById('gasReading').value);
        // Тепер користувач не вводить температуру — ставимо null (алгоритм обчислить пізніше)
        const temperature = null;

        if (!date || isNaN(gasReading)) {
            alert('Будь ласка, заповніть всі поля коректно');
            return;
        }

        const newEntry = {
            date,
            gasReading,
            temperature,
        };

        // Зберігаємо дані в бекенд (асинхронно)
        await this.saveGasDataToFirebase(newEntry);
        
        // Очищення форми
        document.getElementById('dataForm').reset();
        this.setMinDate();

        // Показати подяку користувачу
        this.showThankYou();
    }
    
    // Показує повідомлення "Дякую Мамо" під формою на кілька секунд
    showThankYou(durationMs = 5000) {
        const form = document.getElementById('dataForm');
        if (!form) return;

        let msg = document.getElementById('thank-you');
        if (!msg) {
            msg = document.createElement('div');
            msg.id = 'thank-you';
            msg.setAttribute('role', 'status');
            msg.style.marginTop = '8px';
            msg.style.padding = '6px 10px';
            msg.style.background = '#e6ffed';
            msg.style.border = '1px solid #b7f5c9';
            msg.style.color = '#065f46';
            msg.style.borderRadius = '4px';
            msg.style.fontWeight = '600';
            msg.style.display = 'inline-block';
            msg.style.opacity = '0';
            msg.style.transition = 'opacity 200ms ease';
            form.appendChild(msg);
        }

        const phrases = [
            "Дякую, рідненька, показники прийнято!",
            "Ви найкраща помічниця у світі, матусю!",
            "Дякую, мамо! Ваша турбота зігріває краще за газ.",
            "Отримав! Дякую, що Ви завжди пам’ятаєте.",
            "Мамо, Ви — моє сонечко. Дякую за допомогу!",
            "Супер! Мама на зв’язку — все збережено.",
            "Прийнято! Матусю, Ви просто мега-користувач!",
            "Дякую! З Вами все працює ідеально.",
            "Все чітко! Дякую за цифри, ма.",
            "Готово! Ви — професіонал у цій справі.",
            "Дякую, мамо! Нехай у домі завжди буде тепло.",
            "Цифри в базі. Відпочивайте, рідна!",
            "Дякую! Тепер можна і чаю попити.",
            "Ціную Вашу допомогу, матусю. Обіймаю!",
            "Все надіслано! Ви справжня берегиня нашого дому.",
            "Мама — хакер! Показники успішно внесено.",
            "Місія виконана! Дякую, мамусю.",
            "Газ під контролем, поки Ви поруч. Дякую!",
            "Дякую, ма! Ваші показники — найточніші у світі.",
            "Кінець звітності! Ви молодець, матусю.",
            "Дякую, мамо! Ви моя головна опора.",
            "Дані збережено! Дякую за Вашу старанність.",
            "Як завжди вчасно! Дякую, матусю.",
            "Ваша допомога неоціненна. Дякую за цифри!",
            "Дякую, мамо! З Вами жоден куб газу не загубиться.",
            "Ви — золото! Показники вже в системі.",
            "Дякую! На душі стає тепліше від Вашої допомоги.",
            "Все під контролем! Дякую, найкраща мамо у світі.",
            "Показники прийнято! Ви — взірець відповідальності.",
            "Дякую, матусю! Нехай цей вечір буде затишним."
        ];

        // Випадковий вибір однієї фрази з масиву
        const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

        // Інтеграція у вашу змінну
        msg.textContent = randomPhrase;
        // показати
        requestAnimationFrame(() => { msg.style.opacity = '1'; });

        // скасувати попередній таймер якщо був
        if (msg._hideTimer) {
            clearTimeout(msg._hideTimer);
        }
        msg._hideTimer = setTimeout(() => {
            msg.style.opacity = '0';
            // видалити елемент після анімації
            setTimeout(() => {
                if (msg && msg.parentNode === form) form.removeChild(msg);
            }, 250);
        }, durationMs);
    }
    
    // Метод для розрахунку різниці
    getAllData() {
        // Початкові дані, які не зберігаються у Firebase
        const initialData = this.getInitialData(); 
        
        // Об'єднуємо початкові дані та дані з Firebase
        const combinedData = [...initialData, ...this.data];
        
        // Перераховуємо різниці
        return combinedData.map((entry, index) => {
            let difference = 0;
            
            if (index > 0) {
                // Віднімаємо від попереднього запису в об'єднаному масиві
                const lastEntry = combinedData[index - 1];
                difference = entry.gasReading - lastEntry.gasReading;
            } else if (entry.difference !== undefined) {
                // Якщо це перший запис, використовуємо його difference (якщо є)
                difference = entry.difference;
            }
            
            return {
                ...entry,
                difference: parseFloat(difference.toFixed(2))
            };
        });
    }

    // Метод видалення тепер повинен використовувати Firebase ID
    deleteData(entryIndex) {
        const initialDataLength = this.getInitialData().length;

        if (entryIndex < initialDataLength) {
            alert('Початкові дані не можуть бути видалені. Це лише приклад.');
            return;
        }

        // Індекс у масиві this.data (дані, завантажені з Firebase)
        const firebaseIndex = entryIndex - initialDataLength;
        const entryToDelete = this.data[firebaseIndex];

        if (entryToDelete && confirm(`Ви впевнені, що хочете видалити запис від ${this.formatDate(entryToDelete.date)}?`)) {
            // Викликаємо функцію видалення з Firebase
            this.deleteDataFromFirebase(entryToDelete.id);
        }
    }
    
    // ... (setMinDate, setupEventListeners, getInitialData, formatDate, renderChart залишаються незмінними) ...
    
    // Виправлений renderTable для коректного відображення ID та кнопки
    renderTable() {
        const tbody = document.getElementById('tableBody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const allData = this.getAllData();
        const initialDataLength = this.getInitialData().length;
        const { map } = this.computeDailyAverages();

    // Відображаємо лише останні 5 рядків історії
    const startIndex = Math.max(0, allData.length - 5);
    console.debug('[GasMonitor] renderTable: allData.length=', allData.length, 'startIndex=', startIndex);

        const visible = allData.slice(startIndex);
        console.debug('[GasMonitor] renderTable: visible.length=', visible.length, 'showing indexes', startIndex, '->', allData.length - 1);

        visible.forEach((entry, idx) => {
            const index = startIndex + idx; // оригінальний індекс у allData
            const row = document.createElement('tr');
            
            const differenceClass = entry.difference > 0 ? 'difference-positive' : 
                                  entry.difference < 0 ? 'difference-negative' : 'difference-zero';
            
            const isDeletable = index >= initialDataLength;
            // Робимо парсинг дати охайно — на мобільних браузерах деякі формати можуть бути невалідні
            let dateKey = null;
            try {
                if (entry.date) {
                    const dd = new Date(entry.date);
                    if (!isNaN(dd.getTime())) dateKey = dd.toISOString().split('T')[0];
                }
                if (!dateKey && entry.timestamp instanceof Date) {
                    dateKey = entry.timestamp.toISOString().split('T')[0];
                }
            } catch (err) { dateKey = null; }

            const tempDisplay = (dateKey && map[dateKey] && map[dateKey].outdoorAvg !== null) ? (map[dateKey].outdoorAvg + '°C') : 'Н/Д';

            row.innerHTML = `
                <td class="${differenceClass}">${entry.difference}</td>
                <td>${this.formatDate(entry.date)}</td>
                <td>${entry.gasReading}</td>
                <td>${tempDisplay}</td>
                <td>
                    ${isDeletable ? 
                        `<button class="delete-btn" onclick="gasMonitor.deleteData(${index})" aria-label="Видалити запис">✖</button>` : 
                        ''
                    }
                </td>
            `;
            tbody.appendChild(row);
        });
    }

    setMinDate() {
        const dateInput = document.getElementById('date');
        // Перевірка на null тут є обов'язковою!
        if (!dateInput) {
            console.error("Елемент 'date' не знайдено. Перевірте, чи є він у HTML.");
            return; 
        }
        
        const today = new Date().toISOString().split('T')[0];
        dateInput.value = today;
        dateInput.max = today;
    }

    getInitialData() {
        return [
            { date: '2025-11-22', gasReading: 73435, temperature: 4.5, difference: 6 },
            { date: '2025-11-23', gasReading: 73455, temperature: -1, difference: 20 },
            { date: '2025-11-24', gasReading: 73471, temperature: 0, difference: 16 },
            { date: '2025-11-25', gasReading: 73484, temperature: 3, difference: 13 }
        ];
    }
    
    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString('uk-UA');
    }

    // Додаємо допоміжний метод для обчислення середньодобових температур
    computeDailyAverages() {
		const toLocalDateStr = (tsOrDate) => {
			const d = (typeof tsOrDate === 'number') ? new Date(tsOrDate) : new Date(tsOrDate);
			const y = d.getFullYear();
			const m = String(d.getMonth() + 1).padStart(2, '0');
			const day = String(d.getDate()).padStart(2, '0');
			return `${y}-${m}-${day}`;
		};
		const todayStr = toLocalDateStr(new Date());

		// 1) Аггрегація sensorData по даті (YYYY-MM-DD)
		const groups = {}; // dateStr -> { outdoors: [], indoors: [] }
		(this.sensorData || []).forEach(p => {
			const dateStr = toLocalDateStr(p.ts);
			if (!groups[dateStr]) groups[dateStr] = { outdoors: [], indoors: [] };
			if (p.outdoor_t !== null && !isNaN(p.outdoor_t)) groups[dateStr].outdoors.push(Number(p.outdoor_t));
			if (p.indoor_t !== null && !isNaN(p.indoor_t)) groups[dateStr].indoors.push(Number(p.indoor_t));
		});

		// 2) Додаємо temperature з this.data (gas_readings) як "старі" ручні значення — фолбек для минулих дат
		const gasTempMap = {}; // dateStr -> last known temperature
		(this.data || []).forEach(e => {
			let dateStr = null;
			if (e.date) {
				const parsed = new Date(e.date);
				if (!isNaN(parsed.getTime())) dateStr = toLocalDateStr(parsed);
			}
			if (!dateStr && e.timestamp) {
				const t = (e.timestamp instanceof Date) ? e.timestamp.getTime() : (typeof e.timestamp === 'number' ? e.timestamp : null);
				if (t) dateStr = toLocalDateStr(t);
			}
			if (dateStr && e.temperature !== undefined && e.temperature !== null && !isNaN(Number(e.temperature))) {
				gasTempMap[dateStr] = Number(e.temperature);
			}
		});

		// 3) initialData fallback
		const initialMap = {};
		(this.getInitialData() || []).forEach(e => {
			const dateStr = (e.date instanceof Date) ? toLocalDateStr(e.date) : toLocalDateStr(e.date);
			if (e.temperature !== undefined && e.temperature !== null && !isNaN(Number(e.temperature))) {
				if (!initialMap[dateStr]) initialMap[dateStr] = Number(e.temperature);
			}
		});

		// 4) Об'єднати всі дати
		const allDateSet = new Set([ ...Object.keys(groups), ...Object.keys(gasTempMap), ...Object.keys(initialMap) ]);
		const dateKeys = Array.from(allDateSet).sort();

		const daily = [];
		const map = {};
		dateKeys.forEach(dateStr => {
			const g = groups[dateStr] || { outdoors: [], indoors: [] };
			let outdoorAvg = null;
			let indoorAvg = null;

			if (dateStr < todayStr) {
				// минулі дні: пріоритет gas_readings -> sensorData -> initial
				if (gasTempMap.hasOwnProperty(dateStr)) {
					outdoorAvg = gasTempMap[dateStr];
				} else if (g.outdoors.length > 0) {
					outdoorAvg = g.outdoors.reduce((a,b)=>a+b,0)/g.outdoors.length;
				} else if (initialMap.hasOwnProperty(dateStr)) {
					outdoorAvg = initialMap[dateStr];
				} else {
					outdoorAvg = null;
				}
				indoorAvg = (g.indoors.length > 0) ? (g.indoors.reduce((a,b)=>a+b,0)/g.indoors.length) : null;
			} else {
				// сьогодні і пізніше: тільки sensorData
				outdoorAvg = (g.outdoors.length > 0) ? (g.outdoors.reduce((a,b)=>a+b,0)/g.outdoors.length) : null;
				indoorAvg  = (g.indoors.length > 0)  ? (g.indoors.reduce((a,b)=>a+b,0)/g.indoors.length)  : null;
			}

			const oa = (outdoorAvg !== null && outdoorAvg !== undefined) ? parseFloat(outdoorAvg.toFixed(2)) : null;
			const ia = (indoorAvg !== null && indoorAvg !== undefined) ? parseFloat(indoorAvg.toFixed(2)) : null;

			daily.push({ dateStr, outdoorAvg: oa, indoorAvg: ia });
			map[dateStr] = { outdoorAvg: oa, indoorAvg: ia };
		});

		return { daily, map };
	}

    // Метод видалення тепер повинен використовувати Firebase ID
    deleteData(entryIndex) {
        const initialDataLength = this.getInitialData().length;

        if (entryIndex < initialDataLength) {
            alert('Початкові дані не можуть бути видалені. Це лише приклад.');
            return;
        }

        // Індекс у масиві this.data (дані, завантажені з Firebase)
        const firebaseIndex = entryIndex - initialDataLength;
        const entryToDelete = this.data[firebaseIndex];

        if (entryToDelete && confirm(`Ви впевнені, що хочете видалити запис від ${this.formatDate(entryToDelete.date)}?`)) {
            // Викликаємо функцію видалення з Firebase
            this.deleteDataFromFirebase(entryToDelete.id);
        }
    }
    
    // ... (setMinDate, setupEventListeners, getInitialData, formatDate залишаються незмінними) ...
    
    // renderTable визначено вище та обмежує відображення до останніх 5 рядків

    // ЗАМІНЕНО: loadSensorDataFromFirebase — зберігаємо ts як Date та читаємо indoor_h/outdoor_h
	async loadSensorDataFromFirebase() {
		try {
			const { collection, query, orderBy, onSnapshot } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");
			const colRef = collection(this.db, 'sensor_data');
			const q = query(colRef, orderBy('timestamp', 'asc'));

			if (this.sensorUnsubscribe) {
				try { this.sensorUnsubscribe(); } catch (e) { /* ignore */ }
				this.sensorUnsubscribe = null;
			}

			this.sensorUnsubscribe = onSnapshot(q, (snapshot) => {
				const arr = [];
				snapshot.forEach(doc => {
					const d = doc.data();
					let ts = null;
					if (d.timestamp) {
						if (typeof d.timestamp === 'string') {
							let s = d.timestamp.replace(' ', 'T');
							let parsed = new Date(s);
							if (isNaN(parsed.getTime())) parsed = new Date(Date.parse(d.timestamp));
							ts = isNaN(parsed.getTime()) ? null : parsed.getTime();
						} else if (typeof d.timestamp === 'number') {
							ts = d.timestamp;
						} else if (d.timestamp.toDate) {
							try { ts = d.timestamp.toDate().getTime(); } catch (e) { ts = null; }
						} else if (d.timestamp instanceof Date) {
							ts = d.timestamp.getTime();
						}
					}
					if (ts !== null) {
						const outdoor_h = (d.outdoor_h !== undefined && d.outdoor_h !== null && !isNaN(Number(d.outdoor_h))) ? Number(d.outdoor_h) : null;
						const indoor_h  = (d.indoor_h  !== undefined && d.indoor_h  !== null && !isNaN(Number(d.indoor_h)))  ? Number(d.indoor_h)  : null;

                        // Віднімаємо 1 годину (3600000 ms) від часу, що зчитано зі sensor_data
                        const adjustedTs = (typeof ts === 'number') ? (ts - 3600000) : ts;
                        // Додаємо 22 до всіх indoor_h значень відповідно до запиту
                        const indoor_h_adj = (indoor_h !== null && !isNaN(indoor_h)) ? (Number(indoor_h) + 22) : null;
                        arr.push({
                            id: doc.id,
                            // зберігаємо Date об'єкт (не number) — з корекцією на 1 годину
                            ts: new Date(adjustedTs),
                            indoor_t: (d.indoor_t !== undefined) ? Number(d.indoor_t) : null,
                            outdoor_t: (d.outdoor_t !== undefined) ? Number(d.outdoor_t) : null,
                            indoor_h: indoor_h_adj,
                            outdoor_h
                        });
					}
				});
                this.sensorData = arr.sort((a,b) => a.ts - b.ts);
                const adjustedCount = this.sensorData.filter(r => r.indoor_h !== null).length;
                console.debug('[GasMonitor] loadSensorDataFromFirebase: sensor records=', this.sensorData.length, 'indoor_h_adjusted_count=', adjustedCount);
                this.render();
			}, (err) => {
				console.error("Помилка підписки sensor_data:", err);
			});
		} catch (error) {
			console.error("Помилка завантаження sensor_data:", error);
		}
	}

    // ЗАМІНЕНО: renderChart — використовує time scale + розміщує газові точки за timestamp
    renderChart() {
	// ...existing surrounding code...
	const ctx = document.getElementById('gasChart').getContext('2d');

    const fullData = this.getAllData(); // містить difference, date, gasReading, temperature
    const { map } = this.computeDailyAverages();

    // Знайдемо останню доступну дату у повному наборі (якщо нема, використаємо зараз)
    let lastDate = null;
    for (let i = fullData.length - 1; i >= 0; i--) {
        const d = fullData[i].timestamp instanceof Date ? fullData[i].timestamp : new Date(fullData[i].date);
        if (!isNaN(d.getTime())) { lastDate = d; break; }
    }
    if (!lastDate) lastDate = new Date();

    // Обчислимо cutoff (для last N днів)
    let cutoffDate = null;
    if (lastDate) {
        cutoffDate = new Date(lastDate);
        cutoffDate.setDate(cutoffDate.getDate() - this.defaultDays + 1);
    }

    // Використаємо повні дані, але при необхідності обмежимо видиму область осі X
    const visibleData = fullData;

    // формуємо масив точок для gas (використовуємо timestamp з this.data або date fallback)
    const gasPoints = visibleData.map(e => {
        let x = null;
        if (e.timestamp instanceof Date) x = e.timestamp;
        else {
            try {
                x = new Date(e.date);
                if (isNaN(x.getTime())) x = null;
            } catch (err) { x = null; }
        }
        return { x, y: e.difference, raw: e };
    }).filter(p => p.x !== null);

    // середні зовнішні по датах — перевага: зовнішні дані з API, якщо доступні
    let avgPoints = [];
    if (this.externalTempsLoaded && this.externalTemps) {
        avgPoints = Object.keys(this.externalTemps).map(dateStr => {
            const dateObj = new Date(dateStr + 'T00:00:00');
            return { x: dateObj, y: this.externalTemps[dateStr] };
        }).filter(p => p.y !== null && !isNaN(p.y));
    } else {
        avgPoints = Object.keys(map).map(dateStr => {
            const dateObj = new Date(dateStr + 'T00:00:00');
            return { x: dateObj, y: map[dateStr].outdoorAvg };
        }).filter(p => p.y !== null);
    }

    if (window.gasChartInstance) window.gasChartInstance.destroy();

    // Підготуємо опції осі X з можливими min/max (щоб показувати лише останні N днів)
    const xAxisOptions = {
        type: 'time',
        time: {
            tooltipFormat: 'dd.MM.yyyy HH:mm',
            displayFormats: { hour: 'dd.MM HH:mm', day: 'dd.MM' }
        },
        distribution: 'linear'
    };
    if (!this.showAll && typeof cutoffDate !== 'undefined' && cutoffDate && lastDate) {
        // Передаємо числові мітки часу — надійніше для Chart.js
        try {
            xAxisOptions.min = cutoffDate.getTime();
            xAxisOptions.max = lastDate.getTime();
        } catch (e) {
            xAxisOptions.min = cutoffDate;
            xAxisOptions.max = lastDate;
        }
    }

    // DEBUG: виведемо значення, щоб відстежити, що передається в Chart.js
    console.debug('[GasMonitor] renderChart: showAll=', this.showAll, 'cutoffDate=', cutoffDate, 'lastDate=', lastDate, 'gasPoints=', gasPoints.length);

    window.gasChartInstance = new Chart(ctx, {
		type: 'line',
		data: {
			datasets: [
				{
					label: 'Різниця показників газу (м³)',
					data: gasPoints,
					borderColor: '#667eea',
					backgroundColor: 'rgba(102, 126, 234, 0.08)',
					yAxisID: 'yGas',
					tension: 0.2,
					fill: false,
					pointRadius: 3
				},
				{
					label: 'Середня зовнішня температура (°C)',
				 data: avgPoints,
				 borderColor: '#0ea5a4',
				 backgroundColor: 'rgba(14,165,164,0.08)',
				 yAxisID: 'yTemp',
				 tension: 0.3,
				 spanGaps: true,
				 fill: false,
				 pointRadius: 3
				}
			]
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: 'index', intersect: false },
            scales: {
                x: xAxisOptions,
				yGas: {
					type: 'linear',
					display: true,
					position: 'left',
					title: { display: true, text: 'Різниця газу (м³)' }
				},
				yTemp: {
					type: 'linear',
					display: true,
					position: 'right',
					title: { display: true, text: 'Температура (°C)' },
					grid: { drawOnChartArea: false }
				}
			},
			plugins: {
				zoom: {
					pan: { enabled: true, mode: 'x', threshold: 5 },
					zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
				},
				legend: { position: 'top' },
				title: { display: true, text: 'Динаміка газу та середня зовнішня температура' }
			}
		}
	});
    // DEBUG: перевіримо фактичні значення осі після створення графіку
    try {
        console.debug('[GasMonitor] Chart x axis options (options.scales.x):', window.gasChartInstance.options.scales.x);
        if (window.gasChartInstance.scales && window.gasChartInstance.scales.x) {
            console.debug('[GasMonitor] Chart scale x values (scale.min/max):', window.gasChartInstance.scales.x.min, window.gasChartInstance.scales.x.max);
        }
    } catch (e) { console.warn('[GasMonitor] Помилка при читанні властивостей Chart:', e); }
	// ...existing surrounding code...
}

// ЗАМІНЕНО: renderDetailedChart — смуги (band) для вологості (верхня) та температури (нижня) з time scale
// gas точки фільтруються за періодом, обчислення різниці також для відфільтрованих точок
renderDetailedChart(periodDays = 7) {
    const canvas = document.getElementById('tempDetailChart');
    if (!canvas) return;

    const combined = (this.sensorData || []).slice().sort((a,b) => a.ts - b.ts);
    if (combined.length === 0) return;

    const lastTs = combined[combined.length - 1].ts.getTime();
    const periodMs = periodDays * 24 * 60 * 60 * 1000;
    const cutoff = lastTs - periodMs;
    const filtered = combined.filter(p => p.ts.getTime() >= cutoff);

    // Побудова x/y точок (Chart.js time-ось: {x: Date, y: value})
    const toPoint = (p, field) => ({ x: p.ts, y: (p[field] !== null && p[field] !== undefined) ? p[field] : null });

    // Видаляємо зовнішню температуру, виміряну датчиком (не використовується у графіку)
    const indoorsT  = filtered.map(p => toPoint(p, 'indoor_t'));
    const indoorsH  = filtered.map(p => toPoint(p, 'indoor_h'));

    // Газові точки — використовуємо this.data timestamps (як Date) або date fallback
    const gasPointsAll = (this.data || []).map(e => {
        let x = null;
        if (e.timestamp instanceof Date) x = e.timestamp;
        else if (e.date) {
            const parsed = new Date(String(e.date) + 'T00:00:00');
            if (!isNaN(parsed.getTime())) x = parsed;
        }
        return { x, y: (e.gasReading !== undefined) ? e.gasReading : null };
    }).filter(p => p.x !== null);

    // Фільтруємо газові точки по періоду (cutoff..lastTs)
    const gasPoints = gasPointsAll.filter(p => (p.x.getTime() >= cutoff && p.x.getTime() <= lastTs));

    // Додатково: середні зовнішні добові температури з API для детального графіка
    let externalDailyPoints = [];
    if (this.externalTempsLoaded && this.externalTemps) {
        externalDailyPoints = Object.keys(this.externalTemps).map(dateStr => ({ x: new Date(dateStr + 'T00:00:00'), y: this.externalTemps[dateStr] }))
            .filter(p => p.x.getTime() >= cutoff && p.x.getTime() <= lastTs && p.y !== null && !isNaN(p.y));
    }

    // Обчислюємо різниці між послідовними газовими точками.
    // Важливо: для першої точки у видимому періоді використовуємо попереднє вимірювання,
    // навіть якщо воно поза періодом (щоб перша точка не була завжди 0).
    const gasDiffPoints = [];
    // Переконаємось, що всі газові точки відсортовані за часом
    const sortedGasAll = gasPointsAll.slice().sort((a,b) => a.x.getTime() - b.x.getTime());
    for (let i = 0; i < sortedGasAll.length; i++) {
        const p = sortedGasAll[i];
        const t = p.x.getTime();
        if (t < cutoff || t > lastTs) continue; // лише точки у періоді
        let diff = 0;
        if (i > 0 && typeof sortedGasAll[i-1].y === 'number' && typeof p.y === 'number') {
            diff = p.y - sortedGasAll[i-1].y;
        }
        gasDiffPoints.push({ x: p.x, y: parseFloat(diff.toFixed(2)) });
    }

    if (this.detailChartInstance) this.detailChartInstance.destroy();
    const ctx = canvas.getContext('2d');

    this.detailChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                // видалено: зовнішня температура з датчика (outdoorsT) - не показуємо
                // API daily mean temperatures (if available)
                { label: 'Середня зовнішня темп. (API) (°C)', data: externalDailyPoints, borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.06)', yAxisID: 'yTemp', pointRadius: 3, borderDash: [4,2], spanGaps: true, fill: false },
                { label: 'Внутрішня темп. (°C)', data: indoorsT, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.04)', yAxisID: 'yTemp', pointRadius: 2, spanGaps: true },
                { label: 'Внутрішня вологість (%)', data: indoorsH, borderColor: 'transparent', backgroundColor: 'rgba(234,88,12,0.36)', yAxisID: 'yTemp', pointRadius: 0, spanGaps: true, fill: '-1' },
                { label: 'Різниця газу (м³)', data: gasDiffPoints, borderColor: '#667eea', backgroundColor: 'rgba(102,126,234,0.05)', yAxisID: 'yGas', tension: 0.2, pointRadius: 3 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'time',
                    time: { tooltipFormat: 'dd.MM.yyyy HH:mm', displayFormats: { hour: 'dd.MM HH:mm', day: 'dd.MM' } },
                    distribution: 'linear'
                },
                yTemp: { type: 'linear', display: true, position: 'right', title: { display: true, text: 'Темп. / Вологість (одна вісь)' } },
                yGas: { type: 'linear', display: true, position: 'left', title: { display: true, text: 'Різниця газу (м³)' } }
            },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const lab = context.dataset.label || '';
                            if (/волог/i.test(lab)) return lab + ': ' + (context.parsed.y !== null ? context.parsed.y + '%' : 'Н/Д');
                            if (/Темп|темп/i.test(lab)) return lab + ': ' + (context.parsed.y !== null ? context.parsed.y + '°C' : 'Н/Д');
                            return lab + ': ' + (context.parsed.y !== null ? context.parsed.y : 'Н/Д');
                        }
                    }
                }
            },
            interaction: { mode: 'index', intersect: false }
        }
    });
}
} // <-- Додаємо цю дужку для завершення class GasMonitor

// --- ДОДАНО: ініціалізація класу та запуск ---
window.addEventListener('DOMContentLoaded', () => {
    // Чекаємо, поки window.db буде визначено (ініціалізовано у index.html)
    function tryInitGasMonitor() {
        if (window.db) {
            window.gasMonitor = new GasMonitor();
            if (window.gasMonitor && typeof window.gasMonitor.init === 'function') {
                window.gasMonitor.init();
            }
        } else {
            // Спробувати ще раз через 50мс
            setTimeout(tryInitGasMonitor, 50);
        }
    }
    tryInitGasMonitor();
});