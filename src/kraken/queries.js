// -----------------------------------------------------------------------------
// The GraphQL documents sent to the Kraken API of Octopus Energy Germany.
// Field names checked against the published schema (developer.oeg-kraken.energy)
// and the queries of octopus_germany (MIT, thecem), which runs them daily.
// Read-only: the only mutation is the login (obtainKrakenToken); nothing is
// ever changed on the account, the meters or the devices.
// -----------------------------------------------------------------------------

export const TOKEN = `mutation ObtainKrakenToken($input: ObtainJSONWebTokenInput!) {
  obtainKrakenToken(input: $input) { token payload refreshToken refreshExpiresIn }
}`;

export const ACCOUNTS = `query Accounts {
  viewer { accounts { number } }
}`;

const RATE = `latestGrossUnitRateCentsPerKwh
grossRateInformation { date grossRate rateValidToDate }`;

export const ACCOUNT = `query Account($accountNumber: String!) {
  account(accountNumber: $accountNumber) {
    allProperties {
      id
      electricityMalos {
        maloNumber
        meters { id shouldReceiveSmartMeterData hasSmartMeterGateway }
        agreements {
          id
          validFrom
          validTo
          isRevoked
          product { code fullName isTimeOfUse }
          unitRateInformation {
            __typename
            ... on SimpleProductUnitRateInformation { ${RATE} }
            ... on TimeOfUseProductUnitRateInformation {
              rates {
                timeslotName
                ${RATE}
                timeslotActivationRules { activeFromTime activeToTime }
              }
            }
          }
          unitRateForecast {
            validFrom
            validTo
            unitRateInformation {
              __typename
              ... on SimpleProductUnitRateInformation { latestGrossUnitRateCentsPerKwh }
              ... on TimeOfUseProductUnitRateInformation { rates { latestGrossUnitRateCentsPerKwh } }
            }
          }
        }
      }
    }
  }
}`;

/** Kept apart (as octopus_germany does): a failure here never hides the tariffs. */
export const STANDING_CHARGES = `query StandingCharges($accountNumber: String!) {
  account(accountNumber: $accountNumber) {
    allProperties {
      electricityMalos {
        maloNumber
        agreements { id standingChargeGrossRateInformation { date grossRate rateValidToDate } }
      }
    }
  }
}`;

export const DEVICES = `query FlexDevices($accountNumber: String!) {
  devices(accountNumber: $accountNumber) { id name deviceType }
}`;

/** The device id is checked (letters, digits, dashes) before it is placed in the document. */
export const dispatchesOf = (deviceId) => `query FlexPlannedDispatches {
  flexPlannedDispatches(deviceId: ${JSON.stringify(deviceId)}) { start end type }
}`;

export const MEASUREMENTS = `query Measurements(
  $propertyId: ID!
  $first: Int!
  $after: String
  $utilityFilters: [UtilityFiltersInput!]!
  $startAt: DateTime!
  $endAt: DateTime!
  $timezone: String!
) {
  property(id: $propertyId) {
    measurements(
      first: $first
      after: $after
      utilityFilters: $utilityFilters
      startAt: $startAt
      endAt: $endAt
      timezone: $timezone
    ) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          value
          unit
          ... on IntervalMeasurementType { startAt endAt durationInSeconds }
          metaData {
            utilityFilters {
              ... on ElectricityFiltersOutput { marketSupplyPointId readingDirection }
            }
          }
        }
      }
    }
  }
}`;
