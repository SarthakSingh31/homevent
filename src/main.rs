#![feature(lock_value_accessors)]

use std::time::Duration;

const FAN_PWM: rpi_pal::pwm::Channel = rpi_pal::pwm::Channel::Pwm0;
const AIR_QUALITY_FETCH_INTERVAL: Duration = Duration::from_secs(1);

static CURRENT_TARGET: std::sync::RwLock<AirQualityTarget> =
    std::sync::RwLock::new(AirQualityTarget::Co2);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
enum AirQualityTarget {
    Co2,
    Pm02,
    Tvoc,
    Nox,
}

impl AirQualityTarget {
    #[inline]
    pub const fn target_count(&self) -> f64 {
        match self {
            AirQualityTarget::Co2 => 700.0,
            AirQualityTarget::Pm02 => 10.0,
            AirQualityTarget::Tvoc => 25.0,
            AirQualityTarget::Nox => 10.0,
        }
    }
}

#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AirQuality {
    rco2: f64,
    pm02_compensated: f64,
    tvoc_index: f64,
    nox_index: f64,
}

impl AirQuality {
    const URL: &str = "http://192.168.1.2";

    async fn fetch() -> anyhow::Result<AirQuality> {
        let data = reqwest::get(format!("{}/measures/current", Self::URL))
            .await?
            .json()
            .await?;

        Ok(data)
    }

    #[inline]
    fn get(&self, target: &AirQualityTarget) -> f64 {
        match target {
            AirQualityTarget::Co2 => self.rco2,
            AirQualityTarget::Pm02 => self.pm02_compensated,
            AirQualityTarget::Tvoc => self.tvoc_index,
            AirQualityTarget::Nox => self.nox_index,
        }
    }

    fn max_diff(&self) -> (AirQualityTarget, f64) {
        [
            AirQualityTarget::Co2,
            AirQualityTarget::Pm02,
            AirQualityTarget::Tvoc,
            AirQualityTarget::Nox,
        ]
        .map(|t| (t, self.get(&t)))
        .into_iter()
        .max_by_key(|(t, c)| float_ord::FloatOrd(*c - t.target_count()))
        .expect("This iterator is at least 4 long")
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    println!(
        "Automated Ventilation system running on {}.",
        rpi_pal::system::DeviceInfo::new()?.model()
    );

    let fan_tx = rpi_pal::pwm::Pwm::with_frequency(
        FAN_PWM,
        25_000.0,
        0.0,
        rpi_pal::pwm::Polarity::Normal,
        true,
    )?;

    let (quality_tx, quality_rx) = tokio::sync::watch::channel(AirQuality::fetch().await?);

    tokio::spawn(async move {
        loop {
            match AirQuality::fetch().await {
                Ok(quality) => {
                    if let Err(e) = quality_tx.send(quality) {
                        eprintln!("Failed to send the air quality update: {e}");
                    }
                }
                Err(e) => eprintln!("Failed to fetch air quality: {e}"),
            }

            tokio::time::sleep(AIR_QUALITY_FETCH_INTERVAL).await;
        }
    });

    let (duty_cycle_tx, duty_cycle_rx) = tokio::sync::watch::channel(0.0);

    tokio::spawn({
        let mut quality_rx = quality_rx.clone();

        async move {
            let mut prev_pid = None;

            fn pid_controller(target: f64) -> pid::Pid<f64> {
                let mut pid = pid::Pid::new(target, 1.0);
                pid.p(-0.001, f64::MAX)
                    .i(-0.0001, f64::MAX)
                    .d(0.00001, f64::MAX);
                pid
            }

            loop {
                if let Err(e) = quality_rx.changed().await {
                    eprintln!("Failed to watch for changes in air quality: {e}");
                }

                let quality = *quality_rx.borrow();
                let mut target = CURRENT_TARGET.get_cloned().expect("Lock is poisoned");
                let pid = match &mut prev_pid {
                    Some(pid) => pid,
                    None => {
                        prev_pid = Some(pid_controller(target.target_count()));

                        prev_pid.as_mut().expect("We just created the pid")
                    }
                };

                let mut current_count = quality.get(&target);

                let output = if current_count < target.target_count() {
                    (target, current_count) = quality.max_diff();

                    CURRENT_TARGET.set(target).expect("Lock posioned");

                    pid.setpoint = target.target_count();

                    pid.next_control_output(current_count).output
                } else {
                    pid.next_control_output(current_count).output
                };
                let output = output.clamp(0.0, 1.0);

                println!(
                    "Updated fan speed to {output:.4} due to {:?} (current: {}, target: {})",
                    target,
                    quality.get(&target),
                    target.target_count(),
                );

                if let Err(e) = fan_tx.set_duty_cycle(output) {
                    eprintln!("Failed to set the duty cycle: {e}");
                }

                if let Err(e) = duty_cycle_tx.send(output) {
                    eprintln!("Failed to update duty cycle stats: {e}");
                }
            }
        }
    });

    // build our application with a single route
    let app = axum::Router::new().route(
        "/",
        axum::routing::get(|| async move {
            let target = CURRENT_TARGET.get_cloned().expect("Lock posioned");

            axum::Json(serde_json::json!({
                "target": {
                    "metric": target,
                    "value": target.target_count(),
                },
                "quality": *quality_rx.borrow(),
                "duty_cycle": duty_cycle_rx.borrow().clone(),
            }))
        }),
    );

    let listener = tokio::net::TcpListener::bind("0.0.0.0:80").await?;

    Ok(axum::serve(listener, app).await?)
}
